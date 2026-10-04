// Which Supabase project the app talks to.
// Opened from this computer (localhost) it uses the local test database; anywhere else, production.
// The code is identical in both cases; only the data differs.
// These are publishable keys, safe to ship in a web page: the database rules decide who can see what.
(function () {
  var local = ['localhost', '127.0.0.1'].indexOf(location.hostname) >= 0;
  window.POKER_CONFIG = local
    ? { env: 'local', url: 'http://127.0.0.1:54321', key: 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' }
    : { env: 'prod', url: 'https://vvnwwsrvoxvofywvakzh.supabase.co', key: 'sb_publishable_1FLnhaoJHhgyqi40rz9etw_xpRqQLIo' };
})();
