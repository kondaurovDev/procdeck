import { Effect, Schema as S } from "effect"
import { Command } from "foldkit"
import { CompletedRequest, GotNotifyPermission } from "./message.ts"
import type { NotifyPermission } from "./model.ts"

/**
 * System notifications for a deck the user is not looking at: a crash, a
 * preflight block or an output alert while the tab is hidden or the window
 * unfocused. The browser remembers the permission; whether the user *wants*
 * them is a persisted UI flag (Model.notifications) so the bell can be turned
 * off without digging into site settings.
 */

const supported = (): boolean => typeof Notification !== "undefined"

export const currentNotifyPermission = (): NotifyPermission =>
  supported() ? Notification.permission : "unsupported"

/** Ask the browser; must run from a user gesture (the bell click) to get a prompt. */
export const RequestNotifyPermission = Command.define("RequestNotifyPermission", {
  messages: [GotNotifyPermission],
  execute: Effect.promise(async () => {
    if (!supported()) return GotNotifyPermission({ permission: "unsupported" })
    const permission = await Notification.requestPermission().catch(() => "denied" as const)
    return GotNotifyPermission({ permission })
  })
})

/**
 * Show one, unless the user is already looking at the deck. `tag` collapses
 * repeats for the same proc into one notification; clicking it brings the
 * deck's window back.
 */
export const Notify = Command.define("Notify", {
  args: { title: S.String, body: S.String, tag: S.String },
  messages: [CompletedRequest],
  execute: ({ title, body, tag }) =>
    Effect.sync(() => {
      const watching = !document.hidden && document.hasFocus()
      if (!supported() || Notification.permission !== "granted" || watching) {
        return CompletedRequest()
      }
      const notification = new Notification(title, { body, tag, icon: "/icon-192.png" })
      notification.onclick = () => {
        window.focus()
        notification.close()
      }
      return CompletedRequest()
    })
})

/** Swap the favicon between the plain icon and the badged one. */
export const SetFaviconBadge = Command.define("SetFaviconBadge", {
  args: { on: S.Boolean },
  messages: [CompletedRequest],
  execute: ({ on }) =>
    Effect.sync(() => {
      document
        .querySelector<HTMLLinkElement>('link[rel="icon"]')
        ?.setAttribute("href", on ? "/icon-alert.svg" : "/icon.svg")
      return CompletedRequest()
    })
})
