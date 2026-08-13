require_relative "auth"
require_relative "util"

def log_request
end

def handle_request
  log_request
  helper
  AuthManager.new
end
