// Selma — a slow roaming journal.
// A nudge to get out while the light lasts, a place to note where you went and one thing you
// noticed, and a little map that draws itself from those places.
// Everything is stored in this browser (localStorage); there is no server.

const STORE_KEY = 'selma-roam.v1';
const BACKUP_KEY = 'selma-roam.backup'; // the day the last backup was saved
const TRAIL_WEEKS = 5;
const ROTTERDAM_NOORD = { lat: 51.9340, lon: 4.4720, name: 'Rotterdam-Noord' };

// Ways of getting out. An outing can be several at once (a train, then a walk).
const WAYS = [
  { id: 'foot', name: 'On foot' },
  { id: 'bike', name: 'By bike' },
  { id: 'further', name: 'Further afield' },
];

// How far "take me somewhere" sends you, in kilometres from where you are.
const REACH = {
  foot: { min: 0.8, max: 2.2 },
  bike: { min: 3, max: 7 },
};

const state = loadState();
let pick = null;          // what "take me somewhere" is offering right now
let outingsDay = null;    // the day opened on the trail
let researchOnly = false;
let mapScope = 'near';    // 'near' home, or 'all'
let mapPlace = null;      // the place opened on the map

const $ = (sel) => document.querySelector(sel);
const outingDialog = $('#outing-dialog');
const outingForm = $('#outing-form');

function blankState() {
  return { outings: [], removed: [], later: [], home: null, headed: null };
}

function loadState() {
  try {
    return { ...blankState(), ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return blankState();
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    toast('This browser would not save that.');
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const choose = (list) => list[Math.floor(Math.random() * list.length)];

// Days are keyed by the local date, e.g. 2026-10-30.
function dayKey(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
function keyDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(key, n) {
  const d = keyDate(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}
const longDate = (key) => keyDate(key).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const monthName = (key) => keyDate(key).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const daysBetween = (a, b) => Math.round((keyDate(b) - keyDate(a)) / 864e5);
const clock = (date) => date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const home = () => state.home || ROTTERDAM_NOORD;
const newestFirst = (a, b) => b.day.localeCompare(a.day) || b.at - a.at;
const outingsOn = (key) => state.outings.filter((o) => o.day === key).sort((a, b) => a.at - b.at);

/* ---------- The sun ---------- */

// Sunrise and sunset for a day and place, from the sunrise equation (good to a minute or two).
function sunTimes(date, lat, lon) {
  const rad = Math.PI / 180;
  const sin = (d) => Math.sin(d * rad), cos = (d) => Math.cos(d * rad);
  const noonJD = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12) / 864e5 + 2440587.5;
  const n = Math.round(noonJD - 2451545 + 0.0008);
  const meanNoon = n - lon / 360;
  const M = (357.5291 + 0.98560028 * meanNoon) % 360;
  const C = 1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M);
  const L = (M + C + 180 + 102.9372) % 360;
  const transit = 2451545 + meanNoon + 0.0053 * sin(M) - 0.0069 * sin(2 * L);
  const decl = Math.asin(sin(L) * sin(23.4397)) / rad;
  const cosH = (sin(-0.833) - sin(lat) * sin(decl)) / (cos(lat) * cos(decl));
  const H = Math.acos(Math.max(-1, Math.min(1, cosH))) / rad;
  const toDate = (jd) => new Date((jd - 2440587.5) * 864e5);
  return { rise: toDate(transit - H / 360), set: toDate(transit + H / 360) };
}

function spanWords(ms) {
  const mins = Math.round(ms / 6e4);
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h && m) return `${h} hr ${m} min`;
  return h ? `${h} hr` : `${m} min`;
}

// The light today: a line from sunrise to sunset with the sun where it is now.
function lightHTML() {
  const now = new Date();
  const { lat, lon } = home();
  const { rise, set } = sunTimes(now, lat, lon);
  let words;
  if (now < rise) {
    words = `<strong>The sun rises at ${clock(rise)}</strong> and sets at ${clock(set)}.`;
  } else if (now < set) {
    const left = set - now;
    words = left < 45 * 6e4
      ? `<strong>The sun sets at ${clock(set)}.</strong> Just ${spanWords(left)} of light left. Go catch it.`
      : `<strong>The sun sets at ${clock(set)}.</strong> About ${spanWords(left)} of light left today.`;
  } else {
    const next = sunTimes(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1), lat, lon);
    words = `The sun set at ${clock(set)}. A walk after dark still counts. Tomorrow it rises at ${clock(next.rise)}.`;
  }
  // The line runs from 6:00 to 20:00, so the short days of winter look short.
  const start = new Date(now); start.setHours(6, 0, 0, 0);
  const pos = (d) => Math.max(0, Math.min(100, ((d - start) / (14 * 36e5)) * 100));
  const up = now >= rise && now < set;
  return `<div class="light">
    <div class="sky${up ? '' : ' dark'}" aria-hidden="true">
      <span class="day-span" style="left:${pos(rise)}%; right:${100 - pos(set)}%"></span>
      <span class="sun${up ? '' : ' moon'}" style="left:${pos(now)}%"></span>
      <span class="tick" style="left:${pos(rise)}%">${clock(rise)}</span>
      <span class="tick" style="left:${pos(set)}%">${clock(set)}</span>
    </div>
    <p>${words}</p>
  </div>`;
}

/* ---------- Take me somewhere ---------- */

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

// A random spot some way off in a random direction.
function somewhereNear(from, way) {
  const { min, max } = REACH[way];
  const km = min + Math.random() * (max - min);
  const bearing = Math.random() * 360;
  const rad = Math.PI / 180;
  return {
    way,
    lat: from.lat + (km * Math.cos(bearing * rad)) / 111.32,
    lon: from.lon + (km * Math.sin(bearing * rad)) / (111.32 * Math.cos(from.lat * rad)),
    km,
    toward: COMPASS[Math.round(bearing / 45) % 8],
  };
}

// A town further afield, favoring the ones not yet visited.
function somewhereFurther() {
  const been = new Set(state.outings.map((o) => o.place.toLowerCase()));
  const fresh = FURTHER.filter((p) => !been.has(p.name.toLowerCase()));
  return { way: 'further', ...choose(fresh.length ? fresh : FURTHER) };
}

// A kind of place: the one asked for, or a surprise different from the one just offered.
function somewhereKind(near, q, not) {
  const asked = KINDS.find((k) => k.q === q);
  return { way: 'kind', ...(asked || choose(KINDS.filter((k) => k.q !== not))), near, surprise: !asked };
}

// The list of kinds, for when there's something particular in mind.
function kindsHTML() {
  const plain = (name) => name.replace(/^A /, '').replace(/^./, (c) => c.toUpperCase());
  return `<div class="card somewhere">
    <h3 class="card-title">What kind of place?</h3>
    <p class="hint">Choose one, or let Selma pick.</p>
    <div class="row kinds">
      <button class="btn primary small" data-action="pick" data-way="kind" data-kind="">Surprise me</button>
      ${KINDS.map((k) => `<button class="btn small" data-action="pick" data-way="kind" data-kind="${esc(k.q)}">${esc(plain(k.name))}</button>`).join('')}
    </div>
    <div class="row"><button class="link" data-action="open-pick">Back</button></div>
  </div>`;
}

// Mini biebs and woonerven: one of the nearest you haven't been to, and with it any others close
// enough to make a little round of it. A visit is kept on the outing (in `biebs` or `woonerven`),
// and a pin close by counts too, so one come across on an ordinary walk fills in as well.
const SPOTS = {
  bieb: {
    list: BIEBS.map(([id, lat, lon, name]) => ({ id, lat, lon, name })),
    field: 'biebs',
    one: 'mini bieb', many: 'mini biebs',
    nearKm: 0.06, roundKm: 0.5,
  },
  woonerf: {
    list: WOONERVEN.map(([id, name, lat, lon, lines]) => ({ id, lat, lon, name, lines })),
    field: 'woonerven',
    one: 'woonerf', many: 'woonerven',
    nearKm: 0.04, roundKm: 0.4,
  },
};

// How far a point is from a spot: from its middle, or for a woonerf, from the nearest bit of street.
function kmToSpot(p, spot) {
  if (!spot.lines) return kmBetween(p, spot);
  const kx = 111.32 * Math.cos(p.lat * Math.PI / 180), ky = 111.32;
  const at = (line, i) => ({ x: (line[i + 1] - p.lon) * kx, y: (line[i] - p.lat) * ky });
  let best = Infinity;
  for (const line of spot.lines) {
    for (let i = 0; i < line.length; i += 2) {
      const a = at(line, i), b = i + 3 < line.length ? at(line, i + 2) : a;
      const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len)) : 0;
      best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
    }
  }
  return best;
}

function spotsBeen(kind) {
  const { list, field, nearKm } = SPOTS[kind];
  const been = new Set(state.outings.flatMap((o) => o[field] || []));
  const pins = state.outings.filter((o) => o.lat != null);
  for (const spot of list) {
    if (!been.has(spot.id) && pins.some((o) => kmBetween(o, spot) < 1 && kmToSpot(o, spot) <= nearKm)) been.add(spot.id);
  }
  return been;
}

function somewhereSpot(kind, from, not) {
  const { list, roundKm } = SPOTS[kind];
  const been = spotsBeen(kind);
  const fresh = list.filter((b) => !been.has(b.id) && b.id !== not)
    .map((b) => ({ ...b, km: kmBetween(from, b) }));
  if (!fresh.length) return null;
  const first = choose(fresh.sort((a, b) => a.km - b.km).slice(0, 6));
  const others = fresh.filter((b) => b !== first && kmBetween(b, first) <= roundKm)
    .sort((a, b) => kmBetween(a, first) - kmBetween(b, first)).slice(0, 2);
  const stops = [first, ...others].map(({ id, lat, lon, name }) => ({ id, lat, lon, name }));
  return { way: kind, stops, lat: first.lat, lon: first.lon, ...fromHere(first, from), ids: stops.map((b) => b.id) };
}

// How far, and which way, a place is from where you are.
function fromHere(to, from) {
  const rad = Math.PI / 180;
  const bearing = (Math.atan2((to.lon - from.lon) * Math.cos(from.lat * rad), to.lat - from.lat) / rad + 360) % 360;
  return { km: kmBetween(from, to), toward: COMPASS[Math.round(bearing / 45) % 8] };
}

// The nearest mini bieb Selma knows of, within a short walk of a pin.
function biebNear(at) {
  const near = SPOTS.bieb.list.map((b) => ({ b, km: kmBetween(at, b) })).filter((x) => x.km <= 0.15)
    .sort((a, b) => a.km - b.km)[0];
  return near?.b || null;
}

const farWords = (km) => (km < 1 ? `${Math.max(1, Math.round(km * 10)) * 100} m` : `${km.toFixed(1)} km`);

// Links open Google Maps: a search near you for a kind of place, a town by name, or a spot.
function mapsLink(p) {
  if (p.way === 'kind') return `https://www.google.com/maps/search/${encodeURIComponent(p.q)}/@${p.near.lat.toFixed(5)},${p.near.lon.toFixed(5)},15z`;
  if (SPOTS[p.way]) {
    const at = (b) => `${b.lat.toFixed(6)},${b.lon.toFixed(6)}`;
    if (p.stops.length === 1) return `https://www.google.com/maps/search/?api=1&query=${at(p.stops[0])}`;
    const last = p.stops[p.stops.length - 1];
    return `https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=${at(last)}&waypoints=${p.stops.slice(0, -1).map(at).join('%7C')}`;
  }
  const query = p.name ? `${p.name}, Netherlands` : `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function pickWords(p) {
  if (p.way === 'kind') return `<h3>${esc(p.name)}</h3><p class="how">Find one near you in Maps, or wander until you come across one.</p>`;
  if (p.way === 'bieb') {
    const where = `${farWords(p.km)} ${p.toward}`;
    if (p.stops.length === 1) {
      const name = p.stops[0].name;
      return `<h3>${name ? esc(name) : 'A mini bieb'}</h3><p class="how">${name ? 'A mini bieb, ' : 'About '}${where} of where you are. Bring a book to swap, if you have one.</p>`;
    }
    const named = p.stops.filter((b) => b.name).map((b) => esc(b.name));
    return `<h3>A little round of ${p.stops.length === 2 ? 'two' : 'three'} mini biebs</h3><p class="how">The first is ${where} of where you are, and ${p.stops.length === 2 ? 'the other is' : 'the others are'} a short walk from it${named.length ? `, including ${named.join(' and ')}` : ''}. Bring a book or two to swap.</p>`;
  }
  if (p.way === 'woonerf') {
    const where = `${farWords(p.km)} ${p.toward}`;
    const names = p.stops.map((b) => esc(b.name));
    if (p.stops.length === 1) return `<h3>${names[0]}</h3><p class="how">A woonerf, ${where} of where you are. For the research: look at how it's laid out and how it's used.</p>`;
    return `<h3>A little round of ${p.stops.length === 2 ? 'two' : 'three'} woonerven</h3><p class="how">${names.slice(0, -1).join(', ')} and ${names.at(-1)}, starting ${where} of where you are. For the research: look at how they're laid out and how they're used.</p>`;
  }
  if (p.name) return `<h3>${esc(p.name)}</h3><p class="how">By ${esc(p.how)}.</p>`;
  const far = p.km < 1 ? `${Math.round(p.km * 10) * 100} m` : `${p.km.toFixed(1)} km`;
  const way = p.way === 'bike' ? 'A ride' : 'A walk';
  return `<h3>Somewhere ${far} ${p.toward}</h3><p class="how">${way} from where you are. Open the map to see what's there, or just head ${p.toward} and see.</p>`;
}

function pickHTML() {
  if (!pick) {
    return `<div class="card somewhere">
      <h3 class="card-title">Take me somewhere</h3>
      <p class="hint">Selma picks; you go. No research needed.</p>
      <div class="row">
        <button class="btn" data-action="pick" data-way="foot">A walk</button>
        <button class="btn" data-action="pick" data-way="bike">A bike ride</button>
        <button class="btn" data-action="pick" data-way="further">Further afield</button>
        <button class="btn" data-action="pick" data-way="kind">A kind of place</button>
        <button class="btn" data-action="pick" data-way="bieb">A mini bieb</button>
        <button class="btn" data-action="pick" data-way="woonerf">A woonerf</button>
        <button class="link" data-action="close-pick">Not now</button>
      </div>
      ${laterHTML()}
    </div>`;
  }
  if (pick.choosingKind) return kindsHTML();
  if (pick.finding) return `<div class="card somewhere"><p class="hint">Finding where you are…</p></div>`;
  return `<div class="card somewhere">
    ${pickWords(pick)}
    <p class="noticing">On the way: ${esc(pick.noticing)}</p>
    <div class="row">
      <button class="btn primary" data-action="go">I'll go</button>
      <a class="btn" href="${mapsLink(pick)}" target="_blank" rel="noopener">Open in Maps</a>
      ${pick.way === 'kind'
        ? `${pick.surprise ? `<button class="btn quiet" data-action="pick" data-way="kind" data-kind="">Surprise me again</button>` : ''}
      <button class="btn quiet" data-action="pick" data-way="kind">Another kind</button>`
        : `<button class="btn quiet" data-action="pick" data-way="${pick.way}">Somewhere else</button>`}
      ${pick.way === 'kind' ? '' : '<button class="btn quiet" data-action="save-later">Save for later</button>'}
      <button class="link" data-action="close-pick">Not now</button>
    </div>
  </div>`;
}

// Places Selma offered that you'd like to get to some other day. A mini bieb or woonerf drops off
// the list once you've been.
function laterList() {
  return state.later.filter((p) => !SPOTS[p.way] || !p.ids.every((id) => spotsBeen(p.way).has(id)));
}

function laterTitle(p) {
  if (p.way === 'bieb') return p.stops.length > 1 ? `A round of ${p.stops.length === 2 ? 'two' : 'three'} mini biebs` : p.stops[0].name || 'A mini bieb';
  if (p.way === 'woonerf') return p.stops.map((b) => b.name).join(', ');
  if (p.name) return p.name;
  return `Somewhere ${p.way === 'bike' ? 'by bike' : 'on foot'}, ${p.toward}`;
}

function laterHTML() {
  const list = laterList();
  if (!list.length) return '';
  return `<div class="later">
    <p class="eyebrow">Saved for later</p>
    <ul>${list.map((p) => `<li>
      <span>${esc(laterTitle(p))}</span>
      <button class="link small" data-action="go-later" data-id="${esc(p.id)}">Go now</button>
      <a class="link small" href="${mapsLink(p)}" target="_blank" rel="noopener">Maps</a>
      <button class="link small quiet-link" data-action="drop-later" data-id="${esc(p.id)}" aria-label="Take ${esc(laterTitle(p))} off the list">Remove</button>
    </li>`).join('')}</ul>
  </div>`;
}

function headedHTML() {
  const h = state.headed;
  return `<div class="card headed">
    <p class="eyebrow">You're headed out</p>
    ${pickWords(h)}
    <p class="noticing">On the way: ${esc(h.noticing)}</p>
    <div class="row">
      <button class="btn primary" data-action="back">I'm back</button>
      <a class="btn" href="${mapsLink(h)}" target="_blank" rel="noopener">Open in Maps</a>
      <button class="link" data-action="not-going">Not going after all</button>
    </div>
  </div>`;
}

/* ---------- Where am I ---------- */

function whereAmI() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('none'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      reject,
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60e3 },
    );
  });
}

/* ---------- Today ---------- */

function outingHTML(o, { date = false, place = true } = {}) {
  return `<li class="outing">
    <span class="ways">${(o.ways || []).map((w) => `<i class="way-dot" style="--c: var(--${w})" title="${WAYS.find((x) => x.id === w)?.name || ''}"></i>`).join('')}</span>
    <div class="body">
      ${place ? `<p class="place">${esc(o.place)}${o.research ? ' <span class="tag">for the research</span>' : ''}</p>` : ''}
      ${date ? `<p class="when">${longDate(o.day)}${!place && o.research ? ' <span class="tag">for the research</span>' : ''}</p>` : ''}
      ${o.noticed ? `<p class="noticed">${esc(o.noticed)}</p>` : ''}
    </div>
    <button class="btn danger" data-action="edit-outing" data-id="${o.id}">Edit</button>
  </li>`;
}

function weekStripHTML() {
  const todayKey = dayKey();
  const d = keyDate(todayKey);
  const monday = addDays(todayKey, -((d.getDay() + 6) % 7));
  let marks = '';
  for (let i = 0; i < 7; i++) marks += markHTML(addDays(monday, i), todayKey, false);
  return `<div class="this-week">
    <p class="eyebrow">This week</p>
    <div class="weeks">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => `<span class="wd">${x}</span>`).join('')}${marks}</div>
  </div>`;
}

let picking = false;

function renderToday() {
  const todayKey = dayKey();
  const outs = outingsOn(todayKey);
  let main;
  if (state.headed) {
    main = headedHTML();
  } else if (outs.length) {
    main = `<div class="card been">
      <p class="eyebrow">You've been out today</p>
      <ul class="outing-list">${outs.map((o) => outingHTML(o)).join('')}</ul>
      <div class="row">
        <button class="btn quiet" data-action="note-outing">Note another</button>
        ${picking ? '' : '<button class="link" data-action="open-pick">Take me somewhere</button>'}
      </div>
    </div>`;
  } else {
    main = `<div class="card nudge-out">
      <h2>Not out yet today.</h2>
      <p>Even ten minutes around the block counts.</p>
      <div class="row">
        <button class="btn primary" data-action="note-outing">I went out</button>
        ${picking ? '' : '<button class="btn" data-action="open-pick">Take me somewhere</button>'}
      </div>
    </div>`;
  }
  $('#view-today').innerHTML = `
    ${lightHTML()}
    ${main}
    ${picking && !state.headed ? pickHTML() : ''}
    ${backupDue() ? `<p class="nudge">It's been a while since your last backup. <button class="link" data-action="export">Save one now</button> <button class="link" data-action="backup-later">Later</button></p>` : ''}
    ${weekStripHTML()}`;
}

/* ---------- Trail and outings ---------- */

function markHTML(key, todayKey, openable = true) {
  const outs = outingsOn(key);
  let cls = 'none', fill = '', what = 'stayed in';
  if (key > todayKey) {
    cls = 'ahead';
    what = 'still ahead';
  } else if (outs.length) {
    const ways = WAYS.filter((w) => outs.some((o) => (o.ways || []).includes(w.id)));
    const step = 100 / Math.max(ways.length, 1);
    fill = ways.length > 1
      ? `conic-gradient(${ways.map((w, i) => `var(--${w.id}) ${i * step}% ${(i + 1) * step}%`).join(', ')})`
      : `var(--${ways[0]?.id || 'foot'})`;
    cls = 'out';
    what = 'out: ' + outs.map((o) => o.place).join(', ');
  }
  const label = `${longDate(key)}: ${what}`;
  const inner = `<i${fill ? ` style="background: ${fill}"` : ''}></i>`;
  const today = key === todayKey ? ' today' : '';
  return openable && key <= todayKey
    ? `<button class="mark ${cls}${today}" data-action="open-day" data-day="${key}" aria-pressed="${key === outingsDay}" aria-label="${esc(label)}" title="${esc(label)}">${inner}</button>`
    : `<span class="mark ${cls}${today}" role="img" aria-label="${esc(label)}" title="${esc(label)}">${inner}</span>`;
}

function waysLegend() {
  return WAYS.map((w) => `<span><i class="way-dot" style="--c: var(--${w.id})"></i>${w.name}</span>`).join('');
}

function renderOutings() {
  const todayKey = dayKey();
  const start = keyDate(todayKey);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 7 * (TRAIL_WEEKS - 1));
  let marks = '';
  for (let i = 0; i < TRAIL_WEEKS * 7; i++) marks += markHTML(addDays(dayKey(start), i), todayKey);

  let dayPanel = '';
  if (outingsDay) {
    const outs = outingsOn(outingsDay);
    dayPanel = `<div class="day-panel">
      <h3>${longDate(outingsDay)}</h3>
      ${outs.length ? `<ul class="outing-list">${outs.map((o) => outingHTML(o)).join('')}</ul>` : '<p class="quiet-note">Nothing noted this day.</p>'}
      <button class="btn quiet" data-action="note-outing" data-day="${outingsDay}">Note an outing for this day</button>
    </div>`;
  }
  $('#trail').innerHTML = `
    <div class="weeks">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => `<span class="wd">${x}</span>`).join('')}${marks}</div>
    <div class="legend">${waysLegend()}</div>
    <p class="trail-key">A filled circle is a day you got out, in the colors of how you went. Choose a day to see it or add to it.</p>
    ${dayPanel}`;

  const any = state.outings.some((o) => o.research);
  $('#outings-filter').innerHTML = any ? `<fieldset class="segmented">
      <label><input type="radio" name="research-filter" value="all" ${researchOnly ? '' : 'checked'}><span>Every outing</span></label>
      <label><input type="radio" name="research-filter" value="research" ${researchOnly ? 'checked' : ''}><span>For the research</span></label>
    </fieldset>` : '';

  const list = state.outings.filter((o) => !researchOnly || o.research).sort(newestFirst);
  if (!list.length) {
    $('#outings').innerHTML = `<div class="empty"><p>Where you go will gather here, newest first.</p></div>`;
    return;
  }
  let html = '', month = '';
  for (const o of list) {
    const m = monthName(o.day);
    if (m !== month) {
      html += `${month ? '</ul>' : ''}<h2 class="month">${m}</h2><ul class="outing-list">`;
      month = m;
    }
    html += outingHTML(o, { date: true });
  }
  $('#outings').innerHTML = html + '</ul>';
}

/* ---------- The map ---------- */

// Places are grouped by name, so a park visited ten times is one bigger dot.
function pinnedPlaces() {
  // Outings gather by name, but only where they're near each other, so two mini biebs
  // both called "Mini bieb" stay two dots.
  const places = [];
  for (const o of state.outings.slice().sort((a, b) => a.at - b.at)) {
    if (o.lat == null || o.lon == null) continue;
    const name = o.place.trim().toLowerCase();
    let p = places.find((q) => q.name.trim().toLowerCase() === name && kmBetween(q, o) <= 0.3);
    if (!p) places.push(p = { name: o.place, lat: o.lat, lon: o.lon, outings: [], research: false });
    p.outings.push(o);
    p.research ||= !!o.research;
  }
  return places;
}

const placeKey = (p) => `${p.name.trim().toLowerCase()}@${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;

const kmBetween = (a, b) => {
  const rad = Math.PI / 180;
  const dy = (a.lat - b.lat) * 111.32;
  const dx = (a.lon - b.lon) * 111.32 * Math.cos(((a.lat + b.lat) / 2) * rad);
  return Math.hypot(dx, dy);
};

function renderMap() {
  const h = home();
  const all = pinnedPlaces();
  const NEAR_KM = 12;
  const places = mapScope === 'near' ? all.filter((p) => kmBetween(p, h) <= NEAR_KM) : all;
  const unpinned = state.outings.filter((o) => o.lat == null).length;

  // Fit the dots and home in view, at least a couple of kilometres across. The paper is as wide
  // as the page, and only as tall as the dots need (within limits).
  const W = Math.round(Math.min(720, Math.max(300, $('#map').clientWidth || 720)));
  const PAD = W < 500 ? 30 : 44, TALLEST = W < 500 ? 440 : 560;
  const kx = 111.32 * Math.cos(h.lat * Math.PI / 180), ky = 111.32;
  const pts = [h, ...places];
  const xs = pts.map((p) => (p.lon - h.lon) * kx), ys = pts.map((p) => (h.lat - p.lat) * ky);
  let minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 2.5), spanY = Math.max(maxY - minY, 1);
  const scale = Math.min((W - 2 * PAD) / spanX, (TALLEST - 2 * PAD) / spanY); // pixels per km
  const H = Math.round(Math.max(W < 500 ? 280 : 360, spanY * scale + 2 * PAD + 30));
  const span = Math.max(spanX, (W - 2 * PAD) / scale);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const X = (p) => W / 2 + ((p.lon - h.lon) * kx - cx) * scale;
  const Y = (p) => H / 2 + ((h.lat - p.lat) * ky - cy) * scale;

  // A scale bar of a round number of kilometres, about a fifth of the width.
  const target = span / 5;
  const bar = [0.5, 1, 2, 5, 10, 20, 50, 100].reduce((best, n) => Math.abs(n - target) < Math.abs(best - target) ? n : best, 1);
  const barPx = bar * scale;

  const dots = places.map((p, i) => {
    const r = 7 + Math.sqrt(p.outings.length - 1) * 4;
    const way = p.outings.slice().sort(newestFirst)[0].ways?.[0] || 'foot';
    const open = mapPlace === placeKey(p);
    return `<g class="pin${open ? ' open' : ''}" data-action="open-place" data-place="${esc(placeKey(p))}" tabindex="0" role="button" aria-label="${esc(p.name)}, ${p.outings.length === 1 ? 'once' : p.outings.length + ' times'}">
      ${p.research ? `<circle cx="${X(p).toFixed(1)}" cy="${Y(p).toFixed(1)}" r="${(r + 4).toFixed(1)}" class="research-ring"/>` : ''}
      <circle cx="${X(p).toFixed(1)}" cy="${Y(p).toFixed(1)}" r="${r.toFixed(1)}" style="fill: var(--${way})"/>
      <circle cx="${X(p).toFixed(1)}" cy="${Y(p).toFixed(1)}" r="${(r + 12).toFixed(1)}" class="hit"/>
    </g>`;
  }).join('');

  const opened = mapPlace && all.find((p) => placeKey(p) === mapPlace);

  // Woonerven on the paper as faint lines, and mini biebs as faint circles; both fill in once you've been.
  const inView = (x, y, m = 6) => x > m && x < W - m && y > m && y < H - m;
  const linePath = (l) => 'M' + l.filter((_, i) => i % 2 === 0)
    .map((lat, i) => `${X({ lon: l[2 * i + 1] }).toFixed(1)} ${Y({ lat }).toFixed(1)}`).join(' L');
  const ervenBeen = spotsBeen('woonerf');
  const erven = SPOTS.woonerf.list.filter((w) => inView(X(w), Y(w), -40))
    .map((w) => `<path class="woonerf${ervenBeen.has(w.id) ? ' been' : ''}" d="${w.lines.map(linePath).join(' ')}"/>`).join('');
  const been = spotsBeen('bieb');
  const found = state.outings.filter((o) => o.minibieb && o.lat != null).map((o) => ({ lat: o.lat, lon: o.lon, been: true }));
  const biebs = [...SPOTS.bieb.list.map(({ id, lat, lon }) => ({ lat, lon, been: been.has(id) })), ...found]
    .map(({ lat, lon, been }) => ({ x: X({ lon }), y: Y({ lat }), been }))
    .filter((b) => b.x > 6 && b.x < W - 6 && b.y > 6 && b.y < H - 6)
    .map((b) => `<circle cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="4" class="bieb${b.been ? ' been' : ''}"/>`).join('');
  $('#map').innerHTML = `
    <div class="map-top">
      <fieldset class="segmented">
        <label><input type="radio" name="map-scope" value="near" ${mapScope === 'near' ? 'checked' : ''}><span>Near home</span></label>
        <label><input type="radio" name="map-scope" value="all" ${mapScope === 'all' ? 'checked' : ''}><span>Everywhere</span></label>
      </fieldset>
    </div>
    <div class="map-paper">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="A map of the places you've been">
        <g class="compass" transform="translate(${W - 34} 40)"><path d="M0 -14 L5 4 L0 0 L-5 4 Z"/><text y="22" text-anchor="middle">N</text></g>
        <g class="woonerven">${erven}</g>
        <g class="biebs">${biebs}</g>
        ${dots}
        <g class="home" transform="translate(${X(h).toFixed(1)} ${Y(h).toFixed(1)})"><path d="M-7 1 L0 -7 L7 1 V8 H-7 Z"/></g>
        <g class="scale" transform="translate(${PAD} ${H - 24})">
          <path d="M0 -5 V0 H${barPx.toFixed(1)} V-5"/>
          <text x="${(barPx / 2).toFixed(1)}" y="-9" text-anchor="middle">${bar} km</text>
        </g>
      </svg>
      ${places.length ? '' : `<p class="map-empty">${all.length ? 'Nothing pinned near home yet. Try Everywhere.' : 'Your map draws itself. Each place you pin adds a dot.'}</p>`}
    </div>
    ${opened ? `<div class="day-panel">
      <h3>${esc(opened.name)}</h3>
      <ul class="outing-list">${opened.outings.slice().sort(newestFirst).map((o) => outingHTML(o, { date: true, place: false })).join('')}</ul>
    </div>` : ''}
    <div class="legend">${waysLegend()}<span><i class="way-dot ring"></i>For the research</span><span><i class="home-key"></i>Home</span><span><i class="bieb-key"></i>A mini bieb</span><span><i class="woonerf-key"></i>A woonerf</span></div>
    <p class="trail-key">Bigger dots are places you keep going back to.${unpinned ? ` ${unpinned === 1 ? 'One outing has' : unpinned + ' outings have'} no pin, so ${unpinned === 1 ? "it isn't" : "they aren't"} on the map.` : ''} Mini biebs and woonerven fill in once you've been. They're from <a class="link" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>.</p>`;
}

/* ---------- Navigation ---------- */

const RENDER = { today: renderToday, map: renderMap, outings: renderOutings };
let view = 'today';

function show(next) {
  view = next;
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  for (const name of Object.keys(RENDER)) $(`#view-${name}`).hidden = name !== view;
  RENDER[view]();
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ---------- Noting an outing ---------- */

function setPin(lat, lon, words) {
  queueMicrotask(showBiebMatch);
  outingForm.elements.lat.value = lat ?? '';
  outingForm.elements.lon.value = lon ?? '';
  $('#pin-status').textContent = words;
  $('#found').hidden = true;
}

// Looks up a place by name on OpenStreetMap, nearest to home first, for outings noted afterward.
// Only the name typed is sent.
let found = [];
async function findPlace(name) {
  const h = home();
  const box = [h.lon - 0.4, h.lat + 0.25, h.lon + 0.4, h.lat - 0.25].map((n) => n.toFixed(4)).join(',');
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&countrycodes=nl&accept-language=en&viewbox=${box}&q=${encodeURIComponent(name)}`;
  const results = await fetch(url).then((r) => r.json());
  return results
    .map((r) => {
      const a = r.address || {};
      const street = [a.road || a.pedestrian || a.footway, a.house_number].filter(Boolean).join(' ');
      const town = a.city || a.town || a.village || a.municipality || '';
      return { lat: Number(r.lat), lon: Number(r.lon), title: r.name || name, where: [street, town].filter(Boolean).join(', ') };
    })
    .sort((a, b) => kmBetween(a, h) - kmBetween(b, h))
    .slice(0, 4);
}

let dialogStops = [], dialogSpot = null;
function openOutingDialog(existing, day = '', from = null) {
  outingForm.reset();
  const f = outingForm.elements;
  f.id.value = existing?.id || '';
  f.day.value = existing?.day || day || '';
  const theDay = f.day.value || dayKey();
  $('#outing-heading').textContent = existing ? 'Your outing' : theDay === dayKey() ? 'You went out' : 'An outing';
  $('#outing-day').textContent = theDay === dayKey() ? '' : longDate(theDay);
  $('#remove-outing').hidden = !existing;

  const ways = existing?.ways || (SPOTS[from?.way] ? [from.km > 2.5 ? 'bike' : 'foot'] : from ? [from.way] : []);
  $('#ways').innerHTML = '<legend>How <span class="optional">as many as apply</span></legend>' + WAYS.map((w) =>
    `<label><input type="checkbox" name="ways" value="${w.id}" ${ways.includes(w.id) ? 'checked' : ''}><span>${w.name}</span></label>`).join('');

  const names = [...new Set([...state.outings].sort((a, b) => b.at - a.at).map((o) => o.place))];
  $('#places').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');

  const fromPlace = from?.way === 'bieb' ? (from.stops.length > 1 ? 'Mini bieb round' : from.stops[0].name || 'Mini bieb')
    : from?.way === 'woonerf' ? from.stops.map((b) => b.name).join(', ')
    : from?.way !== 'kind' && from?.name;
  f.place.value = existing?.place || fromPlace || '';
  f.place.placeholder = from?.way === 'kind' ? 'Where did you end up?' : 'e.g., Kralingse Plas, the Zwaanshals, Gouda';
  f.noticed.value = existing?.noticed || '';
  f.research.checked = existing ? !!existing.research : from?.way === 'woonerf';
  f.bieb.checked = existing ? !!(existing.biebs?.length || existing.minibieb) : from?.way === 'bieb';
  f.noticed.placeholder = from?.noticing || choose(NOTICINGS);

  if (existing?.lat != null) setPin(existing.lat, existing.lon, 'Pinned on the map.');
  else if (SPOTS[from?.way]) setPin(from.lat, from.lon, from.stops.length > 1 ? `Pinned at the first ${SPOTS[from.way].one}.` : `Pinned at the ${SPOTS[from.way].one}.`);
  else if (from?.lat != null) setPin(from.lat, from.lon, from.name ? `Pinned at ${from.name}.` : 'Pinned where Selma sent you. Pin where you are if you ended up elsewhere.');
  else setPin(null, null, '');
  found = [];
  // On a round, which of the stops you got to. A single one counts by its pin.
  dialogStops = SPOTS[from?.way] && !existing ? from.stops : [];
  dialogSpot = dialogStops.length ? SPOTS[from.way] : null;
  $('#stops').hidden = dialogStops.length < 2;
  $('#stops').innerHTML = '<legend>Which did you get to?</legend>' + dialogStops.map((b, i) =>
    `<label><input type="checkbox" name="stops" value="${esc(b.id)}" checked><span>${b.name ? esc(b.name) : ['The first', 'The second', 'The third'][i]}</span></label>`).join('');
  showBiebMatch();
  outingDialog.showModal();
}

// With the mini bieb box ticked, which mini bieb the pin is at: one Selma knows of, or a new one.
function showBiebMatch() {
  const f = outingForm.elements;
  let words = '';
  if (f.bieb.checked && !dialogStops.length) {
    const at = f.lat.value ? { lat: Number(f.lat.value), lon: Number(f.lon.value) } : null;
    const known = at && biebNear(at);
    words = !at ? 'Pin it so Selma knows which one.'
      : known ? `That's ${known.name || 'a mini bieb Selma knows of'}, ${Math.round(kmBetween(at, known) * 1000)} m from your pin.`
      : "One Selma didn't know of. It'll go on your map.";
  }
  $('#bieb-status').textContent = words;
}
outingForm.elements.bieb.addEventListener('change', showBiebMatch);

// Typing a place you've been before brings its pin along, and so does a town Selma knows, or the
// name of a woonerf or mini bieb (the one nearest home, since street names repeat from town to town).
outingForm.elements.place.addEventListener('input', (event) => {
  const name = event.target.value.trim().toLowerCase();
  const before = state.outings.find((o) => o.place.trim().toLowerCase() === name && o.lat != null);
  if (before) return setPin(before.lat, before.lon, 'Pinned where you were before.');
  const town = FURTHER.find((p) => p.name.toLowerCase() === name);
  if (town) return setPin(town.lat, town.lon, `Pinned at ${town.name}.`);
  for (const kind of ['woonerf', 'bieb']) {
    const spot = SPOTS[kind].list.filter((b) => b.name?.toLowerCase() === name)
      .sort((a, b) => kmBetween(a, home()) - kmBetween(b, home()))[0];
    if (!spot) continue;
    if (kind === 'bieb') outingForm.elements.bieb.checked = true;
    // For a woonerf, the point on the street nearest its middle, so the pin is on the street itself.
    const at = spot.lines ? spot.lines.flatMap((l) => l.filter((_, i) => i % 2 === 0).map((lat, i) => ({ lat, lon: l[2 * i + 1] })))
      .sort((a, b) => kmBetween(a, spot) - kmBetween(b, spot))[0] : spot;
    return setPin(at.lat, at.lon, `Pinned at the ${SPOTS[kind].one} ${spot.name}, ${farWords(kmBetween(spot, home()))} from home. Use Find it if you meant another.`);
  }
});

/* ---------- Actions ---------- */

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  if (tab) return show(tab.dataset.view);
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const { action } = el.dataset;

  if (action === 'note-outing') openOutingDialog(null, el.dataset.day);
  else if (action === 'edit-outing') openOutingDialog(state.outings.find((o) => o.id === el.dataset.id));
  else if (action === 'close-dialog') el.closest('dialog').close();
  else if (action === 'open-pick') { picking = true; pick = null; renderToday(); }
  else if (action === 'close-pick') { picking = false; pick = null; renderToday(); }
  else if (action === 'pick') {
    const way = el.dataset.way;
    if (way === 'kind' && el.dataset.kind === undefined) {
      pick = { choosingKind: true, q: pick?.q };
      return renderToday();
    }
    const noticing = choose(way === 'woonerf' ? WOONERF_NOTICINGS : NOTICINGS);
    if (way === 'further') {
      pick = { ...somewhereFurther(), noticing };
    } else {
      const was = pick;
      pick = { finding: true, q: was?.q, ids: was?.ids };
      renderToday();
      let from;
      try { from = await whereAmI(); } catch { from = home(); toast('Starting from home, since your location is off.'); }
      if (SPOTS[way]) {
        const spot = somewhereSpot(way, from, was?.ids?.[0]);
        if (!spot) { pick = null; renderToday(); return toast(`You've been to every ${SPOTS[way].one} Selma knows of.`); }
        pick = { ...spot, noticing };
      } else {
        pick = way === 'kind' ? { ...somewhereKind(from, el.dataset.kind, was?.q), noticing } : { ...somewhereNear(from, way), noticing };
      }
    }
    renderToday();
  } else if (action === 'go') {
    state.headed = pick;
    picking = false;
    pick = null;
    save();
    renderToday();
    toast('Enjoy it.');
  } else if (action === 'save-later') {
    state.later.push({ ...pick, id: newId() });
    picking = false;
    pick = null;
    save();
    renderToday();
    toast('Saved for later. It will be under Take me somewhere.');
  } else if (action === 'go-later') {
    const saved = state.later.find((p) => p.id === el.dataset.id);
    if (!saved) return;
    let from;
    try { from = await whereAmI(); } catch { from = home(); }
    const way = SPOTS[saved.way] ? fromHere(saved.stops[0], from) : saved.lat != null && !saved.name ? fromHere(saved, from) : {};
    state.headed = { ...saved, ...way, noticing: choose(saved.way === 'woonerf' ? WOONERF_NOTICINGS : NOTICINGS), laterId: saved.id };
    picking = false;
    pick = null;
    save();
    renderToday();
    toast('Enjoy it.');
  } else if (action === 'drop-later') {
    state.later = state.later.filter((p) => p.id !== el.dataset.id);
    state.removed.push(el.dataset.id);
    save();
    renderToday();
  } else if (action === 'back') {
    openOutingDialog(null, '', state.headed);
  } else if (action === 'not-going') {
    state.headed = null;
    save();
    renderToday();
  } else if (action === 'pin-here') {
    $('#pin-status').textContent = 'Finding where you are…';
    try {
      const at = await whereAmI();
      setPin(at.lat, at.lon, 'Pinned where you are now.');
    } catch {
      $('#pin-status').textContent = "Couldn't find where you are.";
    }
  } else if (action === 'find-place') {
    const name = outingForm.elements.place.value.trim();
    if (!name) {
      $('#pin-status').textContent = 'Type where you went first.';
      return outingForm.elements.place.focus();
    }
    $('#pin-status').textContent = 'Looking…';
    try {
      found = await findPlace(name);
    } catch {
      found = [];
    }
    if (!found.length) {
      $('#pin-status').textContent = "Couldn't find it. It can go without a pin.";
      return;
    }
    $('#pin-status').textContent = found.length === 1 ? 'Is this the one?' : 'Which one?';
    $('#found').innerHTML = found.map((f, i) => `<li><button type="button" data-action="choose-found" data-i="${i}"><b>${esc(f.title)}</b>${f.where ? ` <span>${esc(f.where)}</span>` : ''}</button></li>`).join('');
    $('#found').hidden = false;
  } else if (action === 'choose-found') {
    const f = found[Number(el.dataset.i)];
    if (f) setPin(f.lat, f.lon, `Pinned at ${f.where || f.title}.`);
  } else if (action === 'remove-outing') {
    if (!confirm('Remove this outing? It cannot be brought back.')) return;
    const id = outingForm.elements.id.value;
    state.outings = state.outings.filter((o) => o.id !== id);
    state.removed.push(id); // so bringing in an older backup doesn't bring it back
    save();
    outingDialog.close();
    RENDER[view]();
  } else if (action === 'open-day') {
    outingsDay = outingsDay === el.dataset.day ? null : el.dataset.day;
    renderOutings();
  } else if (action === 'open-place') {
    mapPlace = mapPlace === el.dataset.place ? null : el.dataset.place;
    renderMap();
  } else if (action === 'set-home') {
    try {
      const at = await whereAmI();
      state.home = { ...at, name: 'where you set it' };
      save();
      renderHome();
      RENDER[view]();
      toast('Home is set. Sunset times and the map follow it.');
    } catch {
      toast('Could not find you. Home stays where it was.');
    }
  } else if (action === 'export') exportBackup();
  else if (action === 'import') $('#import-file').click();
  else if (action === 'backup-later') {
    localStorage.setItem(BACKUP_KEY + '-later', addDays(dayKey(), 3));
    renderToday();
  }
});

// Pins on the map open with the keyboard as well.
document.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.pin')) {
    event.preventDefault();
    event.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
});

document.addEventListener('change', (event) => {
  const el = event.target;
  if (el.name === 'research-filter') { researchOnly = el.value === 'research'; renderOutings(); }
  else if (el.name === 'map-scope') { mapScope = el.value; mapPlace = null; renderMap(); }
});

outingForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(outingForm);
  const text = (name) => (data.get(name) || '').trim();
  const ways = data.getAll('ways');
  if (!ways.length) return toast('Choose how you went.');
  const num = (name) => (text(name) === '' ? null : Number(text(name)));
  const fields = {
    ways,
    place: text('place'),
    lat: num('lat'),
    lon: num('lon'),
    noticed: text('noticed'),
    research: data.get('research') === 'on',
  };
  const existing = state.outings.find((o) => o.id === text('id'));
  if (dialogSpot) fields[dialogSpot.field] = dialogStops.length > 1 ? data.getAll('stops') : [dialogStops[0].id];
  // The mini bieb box: the round's stops, or the known one nearest the pin, or a new one at the pin.
  if (data.get('bieb') !== 'on') { fields.biebs = []; fields.minibieb = false; }
  else if (dialogSpot !== SPOTS.bieb) {
    const known = fields.lat != null && biebNear(fields);
    fields.biebs = known ? [known.id] : [];
    fields.minibieb = !known;
  }
  fields.edited = Date.now();
  if (existing) Object.assign(existing, fields);
  else {
    state.outings.push({ id: newId(), at: Date.now(), day: text('day') || dayKey(), ...fields });
    if (state.headed && !text('day')) {
      state.later = state.later.filter((p) => p.id !== state.headed.laterId);
      state.headed = null;
    }
  }
  save();
  outingDialog.close();
  RENDER[view]();
  toast(existing ? 'Saved.' : 'Kept. Glad you went.');
});

/* ---------- Home and backup ---------- */

function renderHome() {
  $('#home-status').textContent = state.home
    ? 'Sunset times and the map center on the home you set.'
    : 'Sunset times and the map center on Rotterdam-Noord.';
}

function renderBackup() {
  const last = localStorage.getItem(BACKUP_KEY);
  $('#backup-status').textContent = last ? `Last backup saved ${longDate(last)}.` : 'No backup saved yet.';
}

// On a phone the backup goes to the share sheet, so it can be AirDropped or saved to Files;
// elsewhere it downloads.
async function exportBackup() {
  const name = `selma-roam-backup-${dayKey()}.json`;
  const json = JSON.stringify({ app: 'selma-roam', version: 1, data: state }, null, 2);
  const file = new File([json], name, { type: 'application/json' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err.name === 'AbortError') return;
      return toast("Couldn't share the backup.");
    }
  } else {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  localStorage.setItem(BACKUP_KEY, dayKey());
  renderBackup();
  RENDER[view]();
}

// A gentle reminder on Today: a week after the first outing if there has never been a backup,
// or two weeks after the last one. "Later" puts it off for three days.
function backupDue() {
  const days = state.outings.map((o) => o.day).sort();
  if (!days.length) return false;
  const later = localStorage.getItem(BACKUP_KEY + '-later');
  if (later && later > dayKey()) return false;
  const last = localStorage.getItem(BACKUP_KEY);
  return last ? daysBetween(last, dayKey()) >= 14 : daysBetween(days[0], dayKey()) >= 7;
}

// Bringing in a backup adds to what's here rather than replacing it, so the phone and the computer
// can trade backups both ways. Where both have an outing, the one edited last wins; one removed on
// either stays removed. Home and where you're headed stay as they are here, unless this device
// has none.
function mergeIn(data) {
  const removed = new Set([...state.removed, ...(data.removed || [])]);
  const when = (o) => o.edited || o.at || 0;
  const byId = new Map(state.outings.map((o) => [o.id, o]));
  let added = 0, updated = 0;
  for (const o of data.outings) {
    if (!o?.id || removed.has(o.id)) continue;
    const here = byId.get(o.id);
    if (!here) { byId.set(o.id, o); added++; }
    else if (when(o) > when(here)) { byId.set(o.id, o); updated++; }
  }
  const gone = state.outings.filter((o) => removed.has(o.id)).length;
  state.outings = [...byId.values()].filter((o) => !removed.has(o.id));
  const laterIds = new Set(state.later.map((p) => p.id));
  state.later = [...state.later, ...(data.later || []).filter((p) => !laterIds.has(p.id))].filter((p) => !removed.has(p.id));
  state.removed = [...removed];
  state.home ||= data.home || null;
  state.headed ||= data.headed || null;
  return { added, updated, gone };
}

const countWords = (n, one) => `${n === 1 ? 'one' : n} ${one}${n === 1 ? '' : 's'}`;

$('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  let data;
  try {
    const parsed = JSON.parse(await file.text());
    data = parsed.app === 'selma-roam' ? parsed.data : parsed;
    if (!Array.isArray(data.outings)) throw new Error();
  } catch {
    return toast('That file is not a Selma roaming journal backup.');
  }
  const { added, updated, gone } = mergeIn(data);
  save();
  show(view);
  const said = [added && `added ${countWords(added, 'outing')}`, updated && `updated ${countWords(updated, 'outing')}`, gone && `removed ${countWords(gone, 'outing')} you'd removed on the other device`].filter(Boolean);
  toast(said.length ? `Brought in: ${said.join(', ')}.` : 'Already up to date. Nothing new in that backup.');
});

renderHome();
renderBackup();
show('today');

// The map is drawn to the width of the page, so it is redrawn when that changes.
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => view === 'map' && renderMap(), 200);
});

// The light changes through the day, so Today is redrawn each minute unless a dialog is open.
setInterval(() => {
  if (view === 'today' && !outingDialog.open) renderToday();
}, 60 * 1000);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
