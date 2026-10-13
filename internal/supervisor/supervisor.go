// Package supervisor runs a deck's processes: their lifecycle, their output
// history, readiness for dependents and the live event feed the UI
// subscribes to.
//
// All state sits behind one mutex. Events are published while it is held, so
// a new subscriber's snapshot and its live feed meet with no gap and no
// duplicate. Slow work — terminating a tree, a preflight check, asking the OS
// for ports — happens outside it; a per-proc lock keeps start/stop/restart of
// one proc from interleaving.
package supervisor

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kondaurovDev/procdeck/internal/config"
	"github.com/kondaurovDev/procdeck/internal/httplog"
	"github.com/kondaurovDev/procdeck/internal/interpose"
	"github.com/kondaurovDev/procdeck/internal/lines"
	"github.com/kondaurovDev/procdeck/internal/ports"
	"github.com/kondaurovDev/procdeck/internal/proc"
)

const (
	defaultCols = 120
	defaultRows = 30
	// backlogBytes is the per-proc replay budget. A fresh browser tab sees
	// each pane's recent history — bounded per proc, so a chatty ticker cannot
	// evict a quiet server's startup lines.
	backlogBytes = 256 * 1024
	// terminateGrace is how long a tree gets between SIGTERM and SIGKILL.
	terminateGrace = 4 * time.Second
	// alertTail is how much recent output alert patterns are matched against;
	// a pattern may straddle chunk boundaries.
	alertTail    = 4096
	pollInterval = time.Second
	marksCap     = 100
)

// ErrUnknownProc is returned for an id the deck does not have.
var ErrUnknownProc = errors.New("unknown proc")

type chunk struct {
	seq  int
	data string
}

type alert struct {
	pattern *regexp.Regexp
	label   string
}

// waiter is a launch in progress: waiting on `needs`, then the preflight.
type waiter struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type runtime struct {
	spec config.Proc
	// resolved is the spec with templates substituted — what actually spawns.
	resolved config.Proc
	dir      string
	// assignedPort is the port procdeck assigned (specs using `${port}`).
	assignedPort int
	// internalPort is where the proc binds when the HTTP observer interposes:
	// procdeck listens on assignedPort and forwards here; 0 = not interposed.
	internalPort int
	// observer is bound at startup and kept for the supervisor's lifetime —
	// the public port answers (502) even while the proc restarts. A pinned
	// public port can be taken by something outside the deck; then the proc
	// parks in "blocked" and Start retries the bind.
	observer *interpose.Observer
	// requiredPort is what readiness keys on: a tree can open a port that is
	// not the service — wrangler's OAuth callback on :8976 must not count as
	// "the backend is up".
	requiredPort int
	alerts       []alert
	expect       *regexp.Regexp

	// op serializes start/stop/restart of this proc.
	op sync.Mutex

	status Status
	proc   *proc.Proc
	waiter *waiter
	spawns int
	ports  []int
	tail   string

	// ready is closed while the proc is ready for dependents and replaced by
	// an open channel when it stops being so.
	ready     chan struct{}
	readyOpen bool

	backlog      []chunk
	backlogBytes int
	seq          int
	lines        lines.Buffer
	http         httplog.Buffer

	cols, rows uint16
}

// Mark is a named position in every proc's line and HTTP streams — "now", to
// diff against.
type Mark struct {
	Name     string         `json:"name"`
	At       int64          `json:"at"`
	Seqs     map[string]int `json:"seqs"`
	HTTPSeqs map[string]int `json:"httpSeqs"`
}

// Supervisor owns a deck's processes.
type Supervisor struct {
	uiPort int
	// ctx ends with the supervisor: launches and the port poll stop.
	ctx    context.Context
	cancel context.CancelFunc
	polled chan struct{}

	mu     sync.Mutex
	order  []*runtime
	byID   map[string]*runtime
	subs   map[*Subscription]struct{}
	marks  []Mark
	closed bool
}

func now() int64 { return time.Now().UnixMilli() }

// Start builds the supervisor, assigns ports and spawns every proc set to
// autostart, in config order.
func Start(loaded *config.Loaded) (*Supervisor, error) {
	assigned, internal, err := assignPorts(loaded.Config.Procs)
	if err != nil {
		return nil, fmt.Errorf("assigning ports: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Supervisor{
		uiPort: loaded.Config.UIPort(),
		ctx:    ctx,
		cancel: cancel,
		polled: make(chan struct{}),
		byID:   map[string]*runtime{},
		subs:   map[*Subscription]struct{}{},
	}
	for _, spec := range loaded.Config.Procs {
		s.add(loaded, spec, assigned, internal)
	}
	// Bind every observer up front, so a stopped proc's public port answers
	// 502 rather than refusing. A taken pin parks its proc before autostart
	// gets to it.
	s.mu.Lock()
	for _, r := range s.order {
		if r.internalPort != 0 {
			s.bindObserver(r)
		}
	}
	s.mu.Unlock()
	go s.poll()
	for _, r := range s.order {
		if r.spec.Autostarts() && r.status.State != Blocked {
			s.Start(r.spec.ID)
		}
	}
	return s, nil
}

// assignPorts gives every spec that asks for one (`${port}`) a port before
// anything spawns — a pin where the spec has one, a free port otherwise. The
// assignments stay stable for the supervisor's lifetime, so `${port:other}`
// references never move. Observed procs (the default) get a pair: the public
// assigned port, where the HTTP observer listens, and a hidden internal one
// the proc actually binds — so `${port:api}` traffic flows through the
// observer and gets captured.
func assignPorts(procs []config.Proc) (assigned, internal map[string]int, err error) {
	var unpinned, observed []string
	for i := range procs {
		if !config.UsesOwnPort(&procs[i]) {
			continue
		}
		if procs[i].Port == nil {
			unpinned = append(unpinned, procs[i].ID)
		}
		if procs[i].Observed() {
			observed = append(observed, procs[i].ID)
		}
	}
	free, err := ports.FindFree(len(unpinned) + len(observed))
	if err != nil {
		return nil, nil, err
	}
	assigned, internal = map[string]int{}, map[string]int{}
	for i := range procs {
		if procs[i].Port != nil && config.UsesOwnPort(&procs[i]) {
			assigned[procs[i].ID] = *procs[i].Port
		}
	}
	for i, id := range unpinned {
		assigned[id] = free[i]
	}
	for i, id := range observed {
		internal[id] = free[len(unpinned)+i]
	}
	return assigned, internal, nil
}

func (s *Supervisor) add(loaded *config.Loaded, spec config.Proc, assigned, internal map[string]int) {
	r := &runtime{
		spec:         spec,
		resolved:     config.Resolve(spec, assigned, internal),
		dir:          loaded.Dir(&spec),
		assignedPort: assigned[spec.ID],
		internalPort: internal[spec.ID],
		status:       Status{ID: spec.ID, State: Stopped},
		ready:        make(chan struct{}),
		cols:         defaultCols,
		rows:         defaultRows,
	}
	if r.assignedPort != 0 {
		// The PaaS contract: the port to bind also arrives as PORT — unless the
		// spec sets PORT itself.
		env := map[string]string{"PORT": strconv.Itoa(cmp.Or(r.internalPort, r.assignedPort))}
		for key, value := range r.resolved.Env {
			env[key] = value
		}
		r.resolved.Env = env
	}
	r.requiredPort = urlPort(r.resolved.URL)
	// Patterns were validated with the config; compiled once here.
	for _, a := range spec.Alerts {
		r.alerts = append(r.alerts, alert{pattern: regexp.MustCompile(a.Pattern), label: a.Label})
	}
	if spec.Preflight != nil && spec.Preflight.Expect != "" {
		r.expect = regexp.MustCompile(spec.Preflight.Expect)
	}
	s.order = append(s.order, r)
	s.byID[spec.ID] = r
}

// urlPort is the explicit port of a url, or 0.
func urlPort(raw string) int {
	parsed, err := url.Parse(raw)
	if err != nil {
		return 0
	}
	port, _ := strconv.Atoi(parsed.Port())
	return port
}

// bindObserver puts the observer on the proc's public port; the caller holds
// s.mu. A free port cannot realistically fail to bind, but a pinned one can:
// the number is chosen by a human, and the likeliest holder is the same
// service started outside procdeck. That parks the one proc in "blocked"
// instead of taking the whole deck down.
func (s *Supervisor) bindObserver(r *runtime) bool {
	observer, err := interpose.StartObserver(r.assignedPort, r.internalPort, func(c httplog.Capture) { s.recordHTTP(r, c) })
	if err != nil {
		hint := fmt.Sprintf("free :%d (is %q already running outside procdeck?), then Start", r.assignedPort, r.spec.ID)
		s.say(r, fmt.Sprintf("\r\nprocdeck: pinned port :%d is taken — cannot observe %q\r\nprocdeck: hint: %s\r\n", r.assignedPort, r.spec.ID, hint))
		s.setStatus(r, Status{ID: r.spec.ID, State: Blocked, Hint: hint})
		return false
	}
	r.observer = observer
	return true
}

func (s *Supervisor) recordHTTP(r *runtime, c httplog.Capture) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r.http.Record(c)
}

func (s *Supervisor) runtime(id string) (*runtime, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.byID[id]
	if !ok {
		return nil, fmt.Errorf("%w %q", ErrUnknownProc, id)
	}
	return r, nil
}

func (s *Supervisor) publish(e Event) {
	for sub := range s.subs {
		sub.push(e)
	}
}

func (s *Supervisor) setStatus(r *runtime, status Status) {
	r.status = status
	s.publish(Event{Type: EventStatus, Status: status})
}

func (s *Supervisor) markReady(r *runtime) {
	if !r.readyOpen {
		r.readyOpen = true
		close(r.ready)
	}
}

func (s *Supervisor) markUnready(r *runtime) {
	if r.readyOpen {
		r.readyOpen = false
		r.ready = make(chan struct{})
	}
	r.ports = nil
}

// say records output — the proc's own, or a line from procdeck itself — in
// the pane's history and streams it.
func (s *Supervisor) say(r *runtime, data string) {
	r.lines.Push(data, now())
	seq := r.seq
	r.seq++
	r.backlog = append(r.backlog, chunk{seq: seq, data: data})
	r.backlogBytes += len(data)
	for r.backlogBytes > backlogBytes && len(r.backlog) > 1 {
		r.backlogBytes -= len(r.backlog[0].data)
		r.backlog = r.backlog[1:]
	}
	s.publish(Event{Type: EventLog, ID: r.spec.ID, Data: data, Seq: seq})
}

// onData streams a chunk, then matches alert patterns against a rolling tail.
// The first match wins until the next spawn resets it.
func (s *Supervisor) onData(r *runtime, data string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.say(r, data)
	if len(r.alerts) == 0 || r.status.Alert != "" {
		return
	}
	r.tail += data
	if len(r.tail) > alertTail {
		r.tail = r.tail[len(r.tail)-alertTail:]
	}
	for _, a := range r.alerts {
		if a.pattern.MatchString(r.tail) {
			status := r.status
			status.Alert = a.label
			s.setStatus(r, status)
			return
		}
	}
}

// spawn starts the proc; the caller holds s.mu. A spawn failure (bad cwd,
// missing binary) marks this one proc, never the whole deck: the error lands
// in the pane like any other output.
func (s *Supervisor) spawn(r *runtime) {
	s.setStatus(r, Status{ID: r.spec.ID, State: Starting})
	s.markUnready(r)
	r.tail = ""
	p, err := proc.Spawn(proc.Options{
		Spec:   r.resolved,
		Dir:    r.dir,
		Cols:   r.cols,
		Rows:   r.rows,
		OnData: func(data string) { s.onData(r, data) },
	})
	if err != nil {
		s.say(r, "\r\nprocdeck: spawn failed: "+err.Error()+"\r\n")
		code := -1
		s.setStatus(r, Status{ID: r.spec.ID, State: Exited, ExitCode: &code})
		return
	}
	r.proc = p
	r.spawns++
	restarts := r.spawns - 1
	// Procs that never listen are ready by virtue of running.
	if r.spec.ReadyWhen == config.ReadyStarted {
		s.markReady(r)
	}
	s.setStatus(r, Status{ID: r.spec.ID, State: Running, Pid: p.Pid, StartedAt: now(), Restarts: restarts})
	go s.watch(r, p, restarts)
}

func (s *Supervisor) watch(r *runtime, p *proc.Proc, restarts int) {
	exit := p.Exit()
	s.mu.Lock()
	defer s.mu.Unlock()
	// A stop or restart let go of this process before it exited.
	if r.proc != p {
		return
	}
	r.proc = nil
	s.markUnready(r)
	code := exit.Code
	s.setStatus(r, Status{
		ID: r.spec.ID, State: Exited, ExitCode: &code, ExitedAt: now(), Signal: exit.Signal, Restarts: restarts,
	})
}

// Start launches a proc that is neither running nor already launching.
func (s *Supervisor) Start(id string) error {
	r, err := s.runtime(id)
	if err != nil {
		return err
	}
	r.op.Lock()
	defer r.op.Unlock()
	s.start(r)
	return nil
}

// start spawns right away when nothing stands in the way. Otherwise the
// launch is declarative: park in "waiting" until every dependency is ready,
// run the preflight gate, then spawn — in a goroutine that stop() cancels.
func (s *Supervisor) start(r *runtime) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || r.proc != nil || r.waiter != nil {
		return
	}
	// An interposed proc without its observer is unreachable on its public
	// port — retry the bind first; a still-taken pin parks it again.
	if r.internalPort != 0 && r.observer == nil && !s.bindObserver(r) {
		return
	}
	if len(r.spec.Needs) == 0 && r.spec.Preflight == nil {
		s.spawn(r)
		return
	}
	if len(r.spec.Needs) > 0 {
		s.setStatus(r, Status{ID: r.spec.ID, State: Waiting})
	}
	ctx, cancel := context.WithCancel(s.ctx)
	w := &waiter{cancel: cancel, done: make(chan struct{})}
	r.waiter = w
	go s.launch(ctx, r, w)
}

func (s *Supervisor) launch(ctx context.Context, r *runtime, w *waiter) {
	defer close(w.done)
	defer w.cancel()
	for _, need := range r.spec.Needs {
		s.mu.Lock()
		ready := s.byID[need].ready
		s.mu.Unlock()
		select {
		case <-ready:
		case <-ctx.Done():
			return
		}
	}
	if !s.gate(ctx, r, w) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() != nil || r.waiter != w || s.closed {
		return
	}
	r.waiter = nil
	s.spawn(r)
}

// gate runs the preflight check and either clears the proc for spawning or
// parks it in "blocked" with the check's output and the hint in the pane.
func (s *Supervisor) gate(ctx context.Context, r *runtime, w *waiter) bool {
	check := r.spec.Preflight
	if check == nil {
		return true
	}
	s.mu.Lock()
	if r.waiter == w {
		s.setStatus(r, Status{ID: r.spec.ID, State: Starting})
	}
	s.mu.Unlock()

	passed, output := proc.Preflight(ctx, check.Shell, r.dir)
	if ctx.Err() != nil {
		return false
	}
	expected := r.expect == nil || r.expect.MatchString(output)
	if passed && expected {
		return true
	}

	reason := ""
	if passed {
		reason = fmt.Sprintf(" (output lacks /%s/)", check.Expect)
	}
	report := []string{fmt.Sprintf("procdeck: preflight failed%s: %s", reason, check.Shell)}
	for _, line := range strings.Split(output, "\n") {
		if line != "" {
			report = append(report, line)
		}
	}
	if check.Hint != "" {
		report = append(report, "procdeck: hint: "+check.Hint)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.waiter == w {
		s.say(r, "\r\n"+strings.Join(report, "\r\n")+"\r\n")
		// The launch is over the moment "blocked" becomes visible, and a
		// client may react with Start instantly — free the slot first.
		r.waiter = nil
		s.setStatus(r, Status{ID: r.spec.ID, State: Blocked, Hint: check.Hint})
	}
	return false
}

// Stop cancels a launch in progress or terminates a running tree, and
// reports the proc stopped.
func (s *Supervisor) Stop(id string) error {
	r, err := s.runtime(id)
	if err != nil {
		return err
	}
	r.op.Lock()
	defer r.op.Unlock()
	s.stop(r)
	return nil
}

func (s *Supervisor) stop(r *runtime) {
	s.mu.Lock()
	if w := r.waiter; w != nil {
		r.waiter = nil
		w.cancel()
		s.mu.Unlock()
		<-w.done
		s.mu.Lock()
		s.setStatus(r, Status{ID: r.spec.ID, State: Stopped})
		s.mu.Unlock()
		return
	}
	p := r.proc
	// Let go first: the exit this causes is not a crash to report.
	r.proc = nil
	if p != nil {
		s.markUnready(r)
	}
	s.mu.Unlock()
	if p == nil {
		return
	}
	p.Terminate(terminateGrace)
	s.mu.Lock()
	s.setStatus(r, Status{ID: r.spec.ID, State: Stopped})
	s.mu.Unlock()
}

// Restart is Stop then Start, as one operation.
func (s *Supervisor) Restart(id string) error {
	r, err := s.runtime(id)
	if err != nil {
		return err
	}
	r.op.Lock()
	defer r.op.Unlock()
	s.stop(r)
	s.start(r)
	return nil
}

// Close terminates every process tree, concurrently, and ends every
// subscription. The supervisor starts nothing afterwards.
func (s *Supervisor) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.mu.Unlock()

	var wg sync.WaitGroup
	for _, r := range s.order {
		wg.Go(func() {
			r.op.Lock()
			defer r.op.Unlock()
			s.stop(r)
		})
	}
	wg.Wait()
	s.cancel()
	<-s.polled

	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.order {
		if r.observer != nil {
			r.observer.Close()
		}
	}
	for sub := range s.subs {
		sub.end()
	}
	clear(s.subs)
}

// poll asks the OS, once a second, which TCP ports every running tree
// listens on; that is the default readiness signal.
func (s *Supervisor) poll() {
	defer close(s.polled)
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
		}
		s.pollOnce()
	}
}

func (s *Supervisor) pollOnce() {
	type target struct {
		r *runtime
		p *proc.Proc
	}
	s.mu.Lock()
	var targets []target
	var pgids []int
	for _, r := range s.order {
		if r.proc != nil {
			targets = append(targets, target{r, r.proc})
			pgids = append(pgids, r.proc.Pid)
		}
	}
	s.mu.Unlock()
	if len(targets) == 0 {
		return
	}

	found := ports.Detect(s.ctx, pgids)

	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range targets {
		r := t.r
		if r.proc != t.p {
			continue // exited while we were looking
		}
		listening := found[t.p.Pid]
		if !slices.Equal(listening, r.ports) {
			r.ports = listening
			status := r.status
			status.Ports = listening
			s.setStatus(r, status)
		}
		if r.spec.ReadyWhen == config.ReadyStarted {
			continue
		}
		// With a url or an assigned port, only that port counts. Interposed
		// procs bind the internal port; the public one is the observer's and
		// never shows up in the tree.
		required := cmp.Or(r.internalPort, r.requiredPort, r.assignedPort)
		if (required == 0 && len(listening) > 0) || slices.Contains(listening, required) {
			s.markReady(r)
		}
	}
}

// Subscribe returns each proc's backlog and current status, a `synced`
// marker, then live events.
func (s *Supervisor) Subscribe() *Subscription {
	s.mu.Lock()
	defer s.mu.Unlock()
	sub := newSubscription(s)
	for _, r := range s.order {
		for _, c := range r.backlog {
			sub.snapshot = append(sub.snapshot, Event{Type: EventLog, ID: r.spec.ID, Data: c.data, Seq: c.seq})
		}
		sub.snapshot = append(sub.snapshot, Event{Type: EventStatus, Status: r.status})
	}
	sub.snapshot = append(sub.snapshot, Event{Type: EventSynced})
	if s.closed {
		sub.end()
	} else {
		s.subs[sub] = struct{}{}
	}
	return sub
}

func (s *Supervisor) unsubscribe(sub *Subscription) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.subs, sub)
}

// List describes every proc, in config order.
func (s *Supervisor) List() []Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	infos := make([]Info, 0, len(s.order))
	for _, r := range s.order {
		link := r.resolved.URL
		if link == "" && r.spec.Port != nil {
			// A pinned proc has a stable public address even with no url in
			// the config — derive the link instead of making the user repeat it.
			link = fmt.Sprintf("http://localhost:%d", *r.spec.Port)
		}
		infos = append(infos, Info{
			ID:           r.spec.ID,
			Command:      proc.Describe(r.resolved),
			URL:          link,
			AssignedPort: r.assignedPort,
			ProxyURL:     fmt.Sprintf("http://%s.localhost:%d", r.spec.ID, s.uiPort),
			Status:       r.status,
		})
	}
	return infos
}

// ProxyPort is where `<id>.localhost` traffic goes: the assigned port, else
// the url's port, else the first non-internal port the tree listens on.
// 0 means nothing to proxy to right now.
func (s *Supervisor) ProxyPort(id string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.byID[id]
	if !ok {
		return 0
	}
	if port := cmp.Or(r.assignedPort, r.requiredPort); port != 0 {
		return port
	}
	for _, port := range r.ports {
		if !ports.IsInternal(port) {
			return port
		}
	}
	return 0
}

// HTTPRecorder is where the `*.localhost` proxy records an exchange for a
// proc — nil when the observer on its assigned port already sees the traffic
// (the proxy forwards into it; recording twice would double-count every
// browser request) or when the proc is unknown.
func (s *Supervisor) HTTPRecorder(id string) interpose.Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.byID[id]
	if !ok || r.internalPort != 0 {
		return nil
	}
	return func(c httplog.Capture) { s.recordHTTP(r, c) }
}

// IDs lists the proc ids in config order.
func (s *Supervisor) IDs() []string {
	ids := make([]string, len(s.order))
	for i, r := range s.order {
		ids[i] = r.spec.ID
	}
	return ids
}

// Write types into a proc's terminal; unknown or stopped procs ignore it.
func (s *Supervisor) Write(id, data string) {
	s.mu.Lock()
	var p *proc.Proc
	if r, ok := s.byID[id]; ok {
		p = r.proc
	}
	s.mu.Unlock()
	if p != nil {
		p.Write(data)
	}
}

// Resize sets a proc's terminal size, remembered across respawns.
func (s *Supervisor) Resize(id string, cols, rows int) {
	if cols <= 0 || rows <= 0 || cols > 0xffff || rows > 0xffff {
		return
	}
	s.mu.Lock()
	r, ok := s.byID[id]
	var p *proc.Proc
	if ok {
		r.cols, r.rows = uint16(cols), uint16(rows)
		p = r.proc
	}
	s.mu.Unlock()
	if p != nil {
		p.Resize(uint16(cols), uint16(rows))
	}
}

// Logs queries the per-proc line buffers.
func (s *Supervisor) Logs(q lines.Query) (lines.Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	buffers := make(map[string]*lines.Buffer, len(s.order))
	for _, r := range s.order {
		buffers[r.spec.ID] = &r.lines
	}
	return lines.Run(buffers, q)
}

// HTTP queries the per-proc exchange rings.
func (s *Supervisor) HTTP(q httplog.Query) (httplog.Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	buffers := make(map[string]*httplog.Buffer, len(s.order))
	for _, r := range s.order {
		buffers[r.spec.ID] = &r.http
	}
	return httplog.Run(buffers, q)
}

// Mark snapshots "now" across every proc's streams under a name. Re-marking
// moves the name to the newest slot; the oldest marks fall off past the cap.
// In memory on purpose — marks die with the deck, re-marking is free.
func (s *Supervisor) Mark(name string) Mark {
	s.mu.Lock()
	defer s.mu.Unlock()
	mark := Mark{Name: name, At: now(), Seqs: map[string]int{}, HTTPSeqs: map[string]int{}}
	for _, r := range s.order {
		mark.Seqs[r.spec.ID] = r.lines.NextSeq()
		mark.HTTPSeqs[r.spec.ID] = r.http.NextSeq()
	}
	s.marks = slices.DeleteFunc(s.marks, func(m Mark) bool { return m.Name == name })
	s.marks = append(s.marks, mark)
	if len(s.marks) > marksCap {
		s.marks = s.marks[1:]
	}
	return mark
}

// GetMark looks a mark up by name.
func (s *Supervisor) GetMark(name string) (Mark, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, mark := range s.marks {
		if mark.Name == name {
			return mark, true
		}
	}
	return Mark{}, false
}
