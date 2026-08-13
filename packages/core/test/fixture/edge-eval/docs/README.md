# Edge Eval Fixture

This directory is a small multi-language corpus used to evaluate the
codegraph edge extractor in its two edge modes.

Each language directory under `src/` holds three modules: an auth
module, a server module, and a util module. The server module of each
language calls a constructor from the auth module and a helper from the
util module, and also calls a local helper defined in its own file.

The `docs/` directory holds only prose. There is no executable code
here, so no symbols and no edges are expected from this file.
