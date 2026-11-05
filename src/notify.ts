/**
 * Desktop notification shown as coming from "herdr-puli" with the puli
 * icon — gdbus is the only way to control the app name (notify-send
 * hardcodes its own). Falls back to icon-less notify-send.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

export async function desktopNotify(title: string, body: string): Promise<void> {
  const icon = new URL("../puli.png", import.meta.url).pathname
  try {
    await exec(
      "gdbus",
      [
        "call", "--session",
        "--dest", "org.freedesktop.Notifications",
        "--object-path", "/org/freedesktop/Notifications",
        "--method", "org.freedesktop.Notifications.Notify",
        "herdr-puli", "0", icon, title, body, "[]", "{}", "8000",
      ],
      { timeout: 10_000 },
    )
    return
  } catch {
    /* gdbus missing or the session bus refused: try the plain tool */
  }
  try {
    await exec("notify-send", ["-i", icon, title, body], { timeout: 10_000 })
  } catch {
    /* no notifier at all: skip silently */
  }
}
