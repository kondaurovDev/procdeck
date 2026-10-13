import { Effect, Queue, Stream } from "effect"
import { Command } from "foldkit"
import { InstallBecameAvailable, Installed, PromptedInstall } from "./message.ts"
import type { Message } from "./message.ts"

/**
 * Web-app install ("add to Dock"). Chromium fires `beforeinstallprompt` when
 * the page qualifies (manifest + secure context — `http://localhost` counts);
 * we hold the event and replay it from our own Install button. Once installed
 * (or when already running standalone) the event never fires, so the button
 * simply never appears. Safari has no prompt API — its users go through
 * File → Add to Dock, and the manifest still supplies name and icon.
 */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

// The stashed event lives outside the Model: it is a live browser object with
// methods, not data. Same arrangement as the xterm registry.
let deferred: BeforeInstallPromptEvent | undefined

export const installStream: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const onPrompt = (event: Event) => {
        event.preventDefault()
        deferred = event as BeforeInstallPromptEvent
        Queue.offerUnsafe(queue, InstallBecameAvailable())
      }
      const onInstalled = () => {
        deferred = undefined
        Queue.offerUnsafe(queue, Installed())
      }
      window.addEventListener("beforeinstallprompt", onPrompt)
      window.addEventListener("appinstalled", onInstalled)
      return { onPrompt, onInstalled }
    }),
    ({ onPrompt, onInstalled }) =>
      Effect.sync(() => {
        window.removeEventListener("beforeinstallprompt", onPrompt)
        window.removeEventListener("appinstalled", onInstalled)
      })
  )
)

/**
 * Show the browser's install dialog. A stashed event can be prompted once;
 * after that (accepted or dismissed) the button goes away until the browser
 * offers a fresh event on a later load.
 */
export const PromptInstall = Command.define("PromptInstall", {
  messages: [PromptedInstall],
  execute: Effect.promise(async () => {
    const event = deferred
    deferred = undefined
    if (event !== undefined) {
      await event.prompt()
      await event.userChoice.catch(() => undefined)
    }
    return PromptedInstall()
  })
})
