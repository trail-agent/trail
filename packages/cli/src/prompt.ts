// Terminal questions, including hidden input for passwords.

import { createInterface } from "node:readline"

export async function ask(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const suffix = fallback ? ` [${fallback}]` : ""
  const answer = await new Promise<string>((resolve) => rl.question(`${question}${suffix}: `, resolve))
  rl.close()
  return answer.trim() || fallback || ""
}

export async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${question} (y/N)`))
}

/** Read a line without echoing it. Ctrl+C aborts. */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    if (!stdin.isTTY) return reject(new Error("A terminal is needed to type a password"))
    process.stdout.write(`${question}: `)
    stdin.setRawMode(true)
    stdin.resume()
    let value = ""
    const finish = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off("data", onData)
      process.stdout.write("\n")
    }
    const onData = (data: Buffer) => {
      for (const char of data.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          finish()
          return resolve(value)
        }
        if (char === "\u0003") {
          finish()
          return reject(new Error("cancelled"))
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1)
        else value += char
      }
    }
    stdin.on("data", onData)
  })
}
