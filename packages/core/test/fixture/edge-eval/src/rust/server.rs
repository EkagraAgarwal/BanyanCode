use crate::auth::AuthManager;
use crate::util::helper;

fn validate() -> bool {
    true
}

fn handle_request() -> AuthManager {
    validate();
    helper();
    AuthManager::new()
}
