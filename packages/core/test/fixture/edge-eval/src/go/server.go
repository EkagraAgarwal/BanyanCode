package main

import "fixture/src/go/auth"

func logRequest() {
}

func handleRequest() auth.AuthManager {
	logRequest()
	Helper()
	return auth.New()
}
