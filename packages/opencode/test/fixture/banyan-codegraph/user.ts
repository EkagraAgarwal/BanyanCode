export interface User {
  id: string
  name: string
}

export type UserID = string

export class UserService {
  private users: Map<UserID, User>

  constructor() {
    this.users = new Map()
  }

  addUser(user: User): void {
    this.users.set(user.id, user)
  }

  getUser(id: UserID): User | undefined {
    return this.users.get(id)
  }
}

export function createUser(name: string): User {
  return { id: crypto.randomUUID(), name }
}