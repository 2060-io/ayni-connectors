/**
 * The service behind the in-memory provider: accounts, a file store and a calendar server held in memory, with what a
 * test does "by other means" (common §13): items the profile cannot make (a shortcut, a document of the store's own,
 * two items of one name, a floating time, a meeting link), a service that stops or asks before it writes, and the
 * messages the service sends.
 */

/** An account of the service. Every example is fictional. */
export interface MemoryUser {
  id: string
  /** the name people go by */
  name: string
  email: string
  /** the bearer token the account's requests carry */
  token: string
}

/** A message the service sent: an invitation, a change, a cancellation, a reply, a share. */
export interface SentMessage {
  to: string
  kind: 'share' | 'invitation' | 'update' | 'cancellation' | 'reply'
  subject: string
  text: string
}

export class MemoryService {
  public readonly users: MemoryUser[]
  public readonly outbox: SentMessage[] = []
  /** false: every call answers `unavailable`, as a stopped service */
  public available = true
  /** true: every write asks the person first (FEAT-CORE-024) */
  public askBeforeWrite = false
  private counter = 0
  private clock: () => number

  public constructor(users: MemoryUser[], now: () => number = () => Date.now()) {
    this.users = users
    this.clock = now
  }

  /** A new identifier, never given before. */
  public next(prefix: string): string {
    this.counter++
    return `${prefix}${this.counter.toString(36)}`
  }

  public now(): number {
    return this.clock()
  }

  public userByToken(token: string): MemoryUser | undefined {
    return this.users.find((u) => u.token === token)
  }

  public userById(id: string): MemoryUser | undefined {
    return this.users.find((u) => u.id === id)
  }

  public userByEmail(email: string): MemoryUser | undefined {
    const e = email.toLowerCase()
    return this.users.find((u) => u.email.toLowerCase() === e)
  }

  public send(message: SentMessage): void {
    this.outbox.push(message)
  }

  /** The messages sent to an address. */
  public messagesTo(address: string): SentMessage[] {
    const a = address.toLowerCase()
    return this.outbox.filter((m) => m.to.toLowerCase() === a)
  }
}
