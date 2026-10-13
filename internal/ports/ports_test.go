package ports

import (
	"context"
	"net"
	"os"
	"slices"
	"strconv"
	"syscall"
	"testing"
)

func TestFindFreeHandsOutDistinctPorts(t *testing.T) {
	free, err := FindFree(5)
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(free)
	if len(slices.Compact(free)) != 5 {
		t.Fatalf("duplicates in %v", free)
	}
	// Released again: each one binds.
	for _, port := range free {
		l, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			t.Fatalf("port %d still held: %v", port, err)
		}
		l.Close()
	}
}

func TestDetectFindsThisProcessGroup(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	port := l.Addr().(*net.TCPAddr).Port
	pgid, _ := syscall.Getpgid(os.Getpid())

	found := Detect(context.Background(), []int{pgid})
	if !slices.Contains(found[pgid], port) {
		t.Fatalf("Detect = %v, want %d in group %d", found, port, pgid)
	}
	if Detect(context.Background(), []int{2_000_000_000}) != nil {
		t.Fatal("a group that does not exist listens on something")
	}
}

func TestIsInternal(t *testing.T) {
	for port, want := range map[int]bool{3000: false, 9229: true, 9249: true, 9250: false, 49152: true, 8787: false} {
		if IsInternal(port) != want {
			t.Errorf("IsInternal(%d) = %v", port, !want)
		}
	}
}
