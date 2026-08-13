<?php

require_once "auth.php";
require_once "util.php";

function log_request()
{
}

function handleRequest()
{
    log_request();
    helper();
    return new AuthManager();
}
