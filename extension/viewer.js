/* ───────────────────────────────────────────────────────────────────────────
 * Multirror — GD Level Queue · Twitch Extension front-end (Panel + Mobile)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * ONE SETTING TO CHANGE:
 *   EBS_ORIGIN — the public HTTPS URL of the bot (the same host that
 *   WEBSUB_PUBLIC_URL uses). The EBS routes /ext/state and /ext/submit are
 *   mounted there by src/plugins/twitch-ext. No trailing slash.
 *
 * The EBS is a generic host: /ext/state and every PubSub broadcast carry a
 * FEEDS ENVELOPE — one entry per plugin that registered a panel feed. This
 * front-end is the "GD Level Queue" extension, so it reads its own slice:
 *   state.feeds['gd-queue'].data → { enabled, queueLength, queue, nowPlaying }
 *
 * How it behaves:
 *   • While the channel streams an active category (Geometry Dash by
 *     default — configured on the gd-queue plugin, not the front-end), the
 *     feed reports active:true → this page shows the queue + "Now Playing"
 *     + a submit form wired to the same queue as the !q chat command.
 *   • Any other category, offline, or an unreachable EBS → the static
 *     "No active Extension" page.
 *   • Viewers never type a name. Twitch tells the EBS who they are: the
 *     signed viewer JWT carries their login, so the queue shows real
 *     Twitch names, and this page highlights your own card ("YOU").
 *     Anonymous viewers get a stable Viewer-XXXX handle server-side.
 *   • The form takes a Level ID plus optional notes — exactly like the
 *     chat command "!q <levelId> [notes]".
 *   • Live updates arrive as Twitch PubSub broadcasts (window.Twitch.ext
 *     listen('broadcast')); a 30 s /ext/state poll acts as a self-healing
 *     safety net for missed broadcasts.
 *
 * CSP notes: no inline scripts/styles, no external fonts or images —
 * everything renders from this origin + DOM APIs (textContent only, so
 * queue data can never inject HTML).
 * ─────────────────────────────────────────────────────────────────────────── */

var EBS_ORIGIN = 'https://REPLACE-WITH-YOUR-BOT-DOMAIN';   /* ← EDIT ME */

/* Which registered feed this front-end renders (the gd-queue plugin's). */
var FEED_ID = 'gd-queue';

(function () {
  'use strict';

  var POLL_MS_TWITCH = 30000;  // self-healing snapshot refresh
  var POLL_MS_DEV    = 5000;   // faster loop while developing without Twitch

  var DEV_MODE = !(window.Twitch && window.Twitch.ext);
  var API = String(EBS_ORIGIN || '').replace(/\/+$/, '');

  // Local-development override (works without the Twitch iframe):
  //   localStorage.setItem('multirrorEbsOrigin', 'http://localhost:8899')
  // Clear it with localStorage.removeItem(...) when done.
  try {
    var stored = window.localStorage.getItem('multirrorEbsOrigin');
    if (stored !== null) API = stored.replace(/\/+$/, '');
    else if (DEV_MODE) API = ''; // same origin → pairs with a local mock/proxy
  } catch (e) { /* storage unavailable — keep EBS_ORIGIN */ }

  var state    = null;   // last envelope from the EBS
  var stateData = null;  // our feed's data (feeds[FEED_ID].data) while active
  var stateActive = false;
  var token    = null;   // viewer JWT from Twitch.ext.onAuthorized (rotates)
  var gotAuth  = false;
  var myLogin  = null;   // our Twitch login (from the extension context) → "YOU" card

  // Dev-mode stand-in for the Twitch identity (?login=name in the URL) —
  // only read when there is no Twitch helper, purely for local testing.
  if (DEV_MODE) {
    try {
      var m = /[?&]login=([^&]+)/.exec(window.location.search);
      if (m) myLogin = decodeURIComponent(m[1]).trim().toLowerCase() || null;
    } catch (e) { /* bad query string — stay anonymous */ }
  }

  // ── DOM refs (filled in init) ────────────────────────────────────────────
  var viewActive, viewInactive, inactiveDetail,
      nowCard, nowName, nowId, nowBy,
      queueStrip, queueEmpty, queueMore, queueCount, queueClosed,
      form, inputLevel, inputNotes, submitBtn, submitHint, submitAs;

  function $(id) { return document.getElementById(id); }

  // ── Boot ─────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    viewActive    = $('view-active');
    viewInactive  = $('view-inactive');
    inactiveDetail = $('inactive-detail');
    nowCard       = $('now-card');
    nowName       = $('now-name');
    nowId         = $('now-id');
    nowBy         = $('now-by');
    queueStrip    = $('queue-strip');
    queueEmpty    = $('queue-empty');
    queueMore     = $('queue-more');
    queueCount    = $('queue-count');
    queueClosed   = $('queue-closed');
    form          = $('submit-form');
    inputLevel    = $('input-level');
    inputNotes    = $('input-notes');
    submitBtn     = $('submit-btn');
    submitHint    = $('submit-hint');
    submitAs      = $('submit-as');

    form.addEventListener('submit', onSubmit);
    renderIdentity();

    if (!DEV_MODE) {
      var ext = window.Twitch.ext;

      // The same document serves the Panel AND the mobile view — mark the
      // body so CSS can tighten spacing for touch screens.
      try {
        if (ext.viewer && ext.viewer.frameType === 'mobile') {
          document.body.classList.add('view-mobile');
        }
      } catch (e) { /* helper version without viewer.frameType */ }

      // Who we are: Twitch fills context.login for signed-in viewers (it
      // fires repeatedly — only act when a login is actually present).
      try {
        var ctx0 = (typeof ext.getContext === 'function') ? ext.getContext() : null;
        if (ctx0 && ctx0.login) setMyLogin(ctx0.login);
      } catch (e) { /* context not ready yet — onContext below covers us */ }
      try {
        ext.onContext(function (ctx) {
          if (ctx && ctx.login) setMyLogin(ctx.login);
        });
      } catch (e) { /* helper version without onContext */ }

      ext.onAuthorized(function (auth) {
        token = auth && auth.token ? auth.token : null;
        if (!gotAuth) { gotAuth = true; loadState(); } // token rotates later — just keep it warm
      });

      // Live updates: EBS → Twitch PubSub → every open panel.
      try {
        ext.listen('broadcast', function (target, contentType, message) {
          try { applySnapshot(JSON.parse(message)); } catch (e) { /* bad frame */ }
        });
      } catch (e) { /* listen unavailable — polling still covers us */ }

      setInterval(loadState, POLL_MS_TWITCH);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) loadState();
      });
    } else {
      // Dev mode: no Twitch iframe → poll a local mock (same origin) or the
      // URL stored in localStorage['multirrorEbsOrigin'].
      if (window.console) {
        window.console.log('[multirror-ext] dev mode — polling ' + (API || 'same origin') + '/ext/state');
      }
      loadState();
      setInterval(loadState, POLL_MS_DEV);
    }
  }

  // ── Identity ─────────────────────────────────────────────────────────────

  function setMyLogin(login) {
    var clean = String(login || '').trim().toLowerCase();
    if (!clean || clean === 'anonymous') return;
    if (clean === myLogin) return;
    myLogin = clean;
    renderIdentity();
    if (stateActive && stateData) renderQueue(stateData); // re-flag "YOU"
  }

  /** "as <login>" / "anonymous" chip on the submit card. */
  function renderIdentity() {
    if (!submitAs) return;
    submitAs.hidden = false;
    submitAs.textContent = myLogin ? ('as ' + myLogin) : 'anonymous';
    submitAs.className = 'submit-as' + (myLogin ? '' : ' anon');
  }

  // ── State fetching ───────────────────────────────────────────────────────

  function loadState() {
    var headers = { 'Accept': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    window.fetch(API + '/ext/state', { headers: headers, credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (snap) { applySnapshot(snap); })
      .catch(function () {
        // Keep the last known state. On a cold start (or a dead EBS) the
        // default visible view already reads "No active Extension".
      });
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  /** Our slice of a feeds envelope: { active, data } or null. */
  function myFeed(snap) {
    if (!snap || !snap.feeds || typeof snap.feeds !== 'object') return null;
    var feed = snap.feeds[FEED_ID];
    return (feed && typeof feed === 'object') ? feed : null;
  }

  function applySnapshot(snap) {
    var feed   = myFeed(snap);
    var active = !!(snap && snap.active === true && feed && feed.active === true);

    state       = snap || null;
    stateActive = active;
    stateData   = active ? ((feed && feed.data) || {}) : null;

    if (!active) {
      viewActive.hidden = true;
      viewInactive.hidden = false;
      if (inactiveDetail) {
        inactiveDetail.textContent = (snap && snap.category)
          ? 'Now streaming: ' + snap.category + '.'
          : 'This panel comes alive during Geometry Dash streams.';
      }
      return;
    }

    viewInactive.hidden = true;
    viewActive.hidden = false;

    renderNow(stateData);
    renderQueue(stateData);

    var closed = stateData.enabled === false;
    form.hidden = closed;
    queueClosed.hidden = !closed;
  }

  function renderNow(data) {
    var np = data && data.nowPlaying;
    if (!np || !np.levelId) {
      nowCard.hidden = true;
      return;
    }
    nowCard.hidden = false;
    nowName.textContent = np.name || ('Level ' + np.levelId);
    nowId.textContent = np.levelId;
    nowBy.textContent = np.username ? 'requested by ' + np.username : '';
  }

  function isMine(item) {
    return !!(myLogin && item && item.username &&
              String(item.username).toLowerCase() === myLogin);
  }

  function renderQueue(data) {
    var items = Array.isArray(data.queue) ? data.queue : [];
    var total = (typeof data.queueLength === 'number')
      ? data.queueLength
      : items.length;

    // textContent-only rendering — queue data can never inject HTML.
    queueStrip.textContent = '';

    items.forEach(function (item, i) {
      var li = document.createElement('li');
      li.className = 'queue-item' + (i === 0 ? ' next' : '') + (isMine(item) ? ' mine' : '');

      var top = document.createElement('div');
      top.className = 'qi-top';

      var pos = document.createElement('span');
      pos.className = 'qi-pos';
      pos.textContent = (i === 0 ? '\u25B6 ' : '') + '#' + (i + 1);
      top.appendChild(pos);

      if (isMine(item)) {
        var you = document.createElement('span');
        you.className = 'you-pill';
        you.textContent = 'YOU';
        top.appendChild(you);
      }
      li.appendChild(top);

      var id = document.createElement('div');
      id.className = 'qi-id';
      id.textContent = String(item.levelId || '');
      li.appendChild(id);

      var userRow = document.createElement('div');
      userRow.className = 'qi-user';

      var dot = document.createElement('span');
      dot.className = 'dot ' + (item.platform === 'youtube' ? 'youtube' : 'twitch');

      var name = document.createElement('span');
      name.className = 'qi-name';
      name.textContent = String(item.username || '');

      userRow.appendChild(dot);
      userRow.appendChild(name);
      li.appendChild(userRow);

      if (item.notes) {
        var notes = document.createElement('div');
        notes.className = 'qi-notes';
        notes.textContent = String(item.notes);
        notes.title = String(item.notes);
        li.appendChild(notes);
      }

      queueStrip.appendChild(li);
    });

    queueEmpty.hidden = items.length !== 0;
    queueCount.textContent = String(total);

    var extra = total - items.length;
    queueMore.hidden = !(extra > 0);
    if (extra > 0) queueMore.textContent = '+ ' + extra + ' more in queue';
  }

  // ── Submit flow ──────────────────────────────────────────────────────────

  function hint(text, isErr) {
    submitHint.textContent = text;
    submitHint.className = 'submit-hint' + (isErr ? ' err' : '');
  }

  function onSubmit(ev) {
    ev.preventDefault();
    if (!stateActive || !stateData || stateData.enabled === false) {
      hint('The queue is not accepting requests right now.', true);
      return;
    }

    var levelId = inputLevel.value.trim();
    var notes   = inputNotes.value.trim();

    if (!levelId) { hint('Enter a level ID first.', true); return; }
    if (!/^[0-9a-zA-Z_-]{1,16}$/.test(levelId)) {
      hint('Level ID can only use letters, numbers, - and _ (max 16).', true);
      return;
    }

    submitBtn.disabled = true;

    var headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    // No name is sent: the EBS reads the viewer's Twitch login from the
    // signed JWT — impersonating someone else is impossible.
    var body = { type: 'level-submit', levelId: levelId };
    if (notes) body.notes = notes.slice(0, 80);

    window.fetch(API + '/ext/submit', {
      method: 'POST',
      headers: headers,
      credentials: 'omit',
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json().catch(function () {
          return { ok: false, error: 'Bad response from the queue (HTTP ' + r.status + ')' };
        });
      })
      .then(function (result) {
        submitBtn.disabled = false;
        if (result && result.ok) {
          inputLevel.value = '';
          inputNotes.value = '';
          hint(
            (result.replaced ? 'Updated your request — position #' : 'Added! Position #') +
            result.position,
            false
          );
        } else {
          hint((result && result.error) || 'Could not add your level.', true);
        }
      })
      .catch(function () {
        submitBtn.disabled = false;
        hint('Could not reach the queue — try again in a moment.', true);
      });
  }
})();
