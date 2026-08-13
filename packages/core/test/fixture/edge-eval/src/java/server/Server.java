package server;

import auth.AuthManager;
import util.Helper;

public class Server {
    private boolean validate() {
        return true;
    }

    public AuthManager handleRequest() {
        validate();
        Helper.help();
        return new AuthManager();
    }
}
