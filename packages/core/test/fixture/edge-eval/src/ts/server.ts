import { AuthManager } from "./auth"
import { helper } from "./util"

export function buildRequest(): string {
  return "request"
}

export function handleRequest(): AuthManager {
  buildRequest()
  helper()
  return new AuthManager()
}
