// The BanyanCode plugin boots inside every server fixture. Its background code
// graph build walks the whole git project (the repository, during tests) and
// keeps writing after the fixture's storage scope closes, which starves the
// timing-sensitive endpoint tests on a 2-vCPU runner and spams teardown with
// "Cannot use a closed database". None of these tests exercise the graph.
process.env.BANYANCODEGRAPH_BOOTSTRAP = "0"
