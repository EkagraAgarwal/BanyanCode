#include "auth.hpp"
#include "util.hpp"

static void log_request() {
}

AuthManager handleRequest() {
  log_request();
  helper();
  AuthManager m;
  m.greet();
  return m;
}
