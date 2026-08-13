#include "auth.h"
#include "util.h"

static void log_request(void) {
}

AuthManager* handle_request(void) {
  log_request();
  helper();
  return auth_new();
}
