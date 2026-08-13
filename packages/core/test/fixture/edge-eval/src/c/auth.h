#ifndef AUTH_H
#define AUTH_H

#include <stdlib.h>

typedef struct AuthManager {
  int id;
} AuthManager;

static inline AuthManager* auth_new(void) {
  return (AuthManager*)malloc(sizeof(AuthManager));
}

#endif
