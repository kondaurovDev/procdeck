// Package ports finds what process trees listen on and hands out free ports.
//
// Discovery needs no cooperation from the processes: every proc runs in its
// own session, so its pid is a process group id and the OS can enumerate the
// whole tree — pnpm → vite → workerd — and whatever it listens on. TCP LISTEN
// only, which is exactly what dev servers are.
package ports

import (
	"bufio"
	"bytes"
	"context"
	"net"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Detect maps each process group to the sorted TCP ports its members listen
// on, with one `ps` and one `lsof` for all groups together. Groups listening
// on nothing are absent.
func Detect(ctx context.Context, pgids []int) map[int][]int {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	wanted := make(map[int]bool, len(pgids))
	for _, pgid := range pgids {
		wanted[pgid] = true
	}
	// Both tools exit non-zero on "no results" — that is data, not an error.
	listing, _ := exec.CommandContext(ctx, "ps", "-A", "-o", "pid=,pgid=").Output()
	groupOf := map[int]int{}
	var pids []string
	for _, line := range strings.Split(string(listing), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		pid, err1 := strconv.Atoi(fields[0])
		pgid, err2 := strconv.Atoi(fields[1])
		if err1 == nil && err2 == nil && wanted[pgid] {
			groupOf[pid] = pgid
			pids = append(pids, fields[0])
		}
	}
	if len(pids) == 0 {
		return nil
	}

	// -F pn: machine-readable output, a `p<pid>` line followed by `n<addr>`
	// lines for that process's listening sockets.
	output, _ := exec.CommandContext(ctx, "lsof", "-a", "-P", "-n", "-iTCP", "-sTCP:LISTEN",
		"-p", strings.Join(pids, ","), "-F", "pn").Output()
	found := map[int][]int{}
	pgid := 0
	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "p"):
			pid, _ := strconv.Atoi(line[1:])
			pgid = groupOf[pid]
		case strings.HasPrefix(line, "n") && pgid != 0:
			colon := strings.LastIndexByte(line, ':')
			if port, err := strconv.Atoi(line[colon+1:]); colon >= 0 && err == nil && !slices.Contains(found[pgid], port) {
				found[pgid] = append(found[pgid], port)
			}
		}
	}
	for _, list := range found {
		slices.Sort(list)
	}
	return found
}

// IsInternal reports machinery ports a human never opens: node inspectors
// (9229+) and the ephemeral range, where workerd parks its control sockets.
// Mirrored in the UI's link filtering.
func IsInternal(port int) bool {
	return port >= 49152 || (port >= 9229 && port <= 9249)
}

// FindFree asks the OS for n distinct free ports: bind them all on port 0,
// read the assignments, then release. All sockets stay open until every port
// is known, so one call cannot hand out duplicates.
func FindFree(n int) ([]int, error) {
	listeners := make([]net.Listener, 0, n)
	defer func() {
		for _, l := range listeners {
			l.Close()
		}
	}()
	free := make([]int, 0, n)
	for range n {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, err
		}
		listeners = append(listeners, l)
		free = append(free, l.Addr().(*net.TCPAddr).Port)
	}
	return free, nil
}
