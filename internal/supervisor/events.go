package supervisor

import (
	"encoding/json"
	"sync"
)

// State is where a proc is in its lifecycle.
type State string

const (
	Stopped  State = "stopped"
	Waiting  State = "waiting"
	Starting State = "starting"
	Running  State = "running"
	Exited   State = "exited"
	Blocked  State = "blocked"
)

// Status is a proc's current state. Every transition builds a fresh value, so
// a published status is never mutated afterwards.
type Status struct {
	ID    string `json:"id"`
	State State  `json:"state"`
	Pid   int    `json:"pid,omitempty"`
	// ExitCode is set in state "exited"; -1 means the spawn itself failed.
	ExitCode *int `json:"exitCode,omitempty"`
	// Signal names the signal that ended it ("SIGTERM"), when one did.
	Signal string `json:"signal,omitempty"`
	// StartedAt is the epoch ms of the last successful spawn.
	StartedAt int64 `json:"startedAt,omitempty"`
	// ExitedAt is the epoch ms of the last exit (state "exited" only).
	ExitedAt int64 `json:"exitedAt,omitempty"`
	// Restarts counts spawns beyond the first — crash loops show here.
	Restarts int `json:"restarts,omitempty"`
	// Ports are the TCP ports the process tree listens on (auto-detected).
	Ports []int `json:"ports,omitempty"`
	// Hint says why the proc is blocked (state "blocked" only).
	Hint string `json:"hint,omitempty"`
	// Alert is the label of a matched output alert, cleared on respawn.
	Alert string `json:"alert,omitempty"`
}

// Info is the static description of a proc plus its current status.
type Info struct {
	ID      string `json:"id"`
	Command string `json:"command"`
	URL     string `json:"url,omitempty"`
	// AssignedPort is the port procdeck assigned (specs using `${port}`).
	AssignedPort int `json:"assignedPort,omitempty"`
	// ProxyURL is the stable per-pane address of the built-in reverse proxy.
	ProxyURL string `json:"proxyUrl,omitempty"`
	Status   Status `json:"status"`
}

// EventType tells the three kinds of events apart.
type EventType string

const (
	EventLog    EventType = "log"
	EventStatus EventType = "status"
	EventSynced EventType = "synced"
)

// Event is what the browser receives over SSE. A fresh subscriber first gets
// each proc's buffered backlog (log chunks, then its current status), then
// `synced`, then live events — so the UI knows exactly where history ends and
// news begins.
type Event struct {
	Type EventType
	// ID, Data and Seq belong to log events; Seq is a per-proc chunk counter.
	ID   string
	Data string
	Seq  int
	// Status belongs to status events.
	Status Status
}

func (e Event) MarshalJSON() ([]byte, error) {
	switch e.Type {
	case EventLog:
		return json.Marshal(struct {
			Type EventType `json:"type"`
			ID   string    `json:"id"`
			Data string    `json:"data"`
			Seq  int       `json:"seq"`
		}{e.Type, e.ID, e.Data, e.Seq})
	case EventStatus:
		return json.Marshal(struct {
			Type   EventType `json:"type"`
			Status Status    `json:"status"`
		}{e.Type, e.Status})
	default:
		return json.Marshal(struct {
			Type EventType `json:"type"`
		}{e.Type})
	}
}

// liveBuffer bounds a subscriber's undelivered live events; a stalled tab
// drops its oldest ones rather than holding up the deck.
const liveBuffer = 4096

// Subscription is one subscriber's view of the deck: its snapshot first, then
// live events. Consumers drain it whenever Wake fires.
type Subscription struct {
	owner *Supervisor

	mu       sync.Mutex
	snapshot []Event
	live     []Event
	wake     chan struct{}
	done     chan struct{}
	once     sync.Once
}

func newSubscription(owner *Supervisor) *Subscription {
	return &Subscription{owner: owner, wake: make(chan struct{}, 1), done: make(chan struct{})}
}

func (sub *Subscription) push(e Event) {
	sub.mu.Lock()
	if len(sub.live) >= liveBuffer {
		sub.live = sub.live[1:]
	}
	sub.live = append(sub.live, e)
	sub.mu.Unlock()
	select {
	case sub.wake <- struct{}{}:
	default:
	}
}

// Drain returns everything not yet delivered, oldest first.
func (sub *Subscription) Drain() []Event {
	sub.mu.Lock()
	defer sub.mu.Unlock()
	out := append(sub.snapshot, sub.live...)
	sub.snapshot, sub.live = nil, nil
	return out
}

// Wake fires when new events may be waiting.
func (sub *Subscription) Wake() <-chan struct{} { return sub.wake }

// Done is closed when the subscription ends — the supervisor shut down.
func (sub *Subscription) Done() <-chan struct{} { return sub.done }

// Close ends the subscription.
func (sub *Subscription) Close() {
	sub.owner.unsubscribe(sub)
	sub.end()
}

func (sub *Subscription) end() { sub.once.Do(func() { close(sub.done) }) }
