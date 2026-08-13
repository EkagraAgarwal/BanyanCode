package auth

import "fixture/src/go/util"

type AuthManager struct {
	ID int
}

func New() AuthManager {
	util.Helper()
	return AuthManager{}
}
