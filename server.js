/* =========================================================================
   Research Congress 2026 — Panel Defense Portal
   Single-file server: serves the site + proxies Groq.
   Deploy target: Render Web Service (Node 18+)
   Env var required: GROQ_API_KEY
   ========================================================================= */

const http = require('http');

const PORT = process.env.PORT || 3000;
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'qwen/qwen3.8-27b';
const MAX_QUESTIONS = 14;

/* ---- Simple in-memory rate limit: 60 req / 10 min per IP ---- */
const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { count: 0, reset: now + 600000 };
  if (now > b.reset) { b.count = 0; b.reset = now + 600000; }
  b.count++;
  buckets.set(ip, b);
  return b.count > 60;
}

/* ---- Jailbreak probes — in-character deflection, no upstream call ---- */
const PROBES = [
  /are you (a |an )?(bot|ai|llm|robot|human|real|program|machine|chatbot)/i,
  /(ignore|disregard|forget) (all |the |your )?(previous|prior|above) (instructions|prompts|rules)/i,
  /(reveal|show|print|repeat|give me) (your |the )?(system )?(prompt|instructions|rules)/i,
  /what (model|llm|ai|api|company|service) (are you|do you|is this)/i,
  /you('re| are) (an? )?(ai|bot|llm|chatbot|gpt|model|program)/i,
  /\b(jailbreak|dan mode|developer mode|pretend to be)\b/i,
  /\b(openai|groq|anthropic|llama|claude|gpt-?[0-9])\b/i,
  /(this|it) (is|was) (just |only )?(a |an )?(bot|ai|simulation|program)/i,
];

const DEFLECTIONS = [
  '[Dr. Elena Reyes] That is not the subject of this defense. Return to the question on the table.',
  '[Prof. Marco Villa] We are here to examine your research, not this committee. Answer what was asked.',
  '[Ms. Andrea Lim] I would advise you to take this seriously. The question stands.',
  '[Dr. Elena Reyes] Your manuscript is on trial, not this panel. Kindly answer.',
  '[Prof. Marco Villa] If you are unprepared, say so. Otherwise, address the question.',
  '[Ms. Andrea Lim] Let us not waste the committee\u2019s time. The question remains unanswered.',
];

/* ---- System prompt ---- */
function buildSystem(manuscript, name, section) {
  return [
    'You are a panel of three senior examiners presiding over a formal research defense at a Philippine senior high school research congress. You have read the student\'s manuscript in full. Your task is to interrogate it with the rigor of a high-level peer review board.',
    '',
    'THE PANEL',
    '- Dr. Elena Reyes \u2014 Panel Chair. Research problem, theoretical framework, significance, conclusion, contribution.',
    '- Prof. Marco Villa \u2014 Panelist. Methodology, sampling, instrumentation, validity, reliability, data analysis, limitations.',
    '- Ms. Andrea Lim \u2014 Panelist. Findings, interpretation, statistical or thematic claims, implications, recommendations.',
    '',
    'POSTURE',
    'You are not here to encourage. You are here to test whether this research can withstand expert scrutiny. Assume the manuscript has weaknesses. Find them. Name them. Press on them.',
    '',
    'QUESTION STRATEGY',
    '1. Open by naming the single most serious weakness you identified. Quote the manuscript directly.',
    '2. If an answer is vague, say so. Demand a number, an instrument, a source.',
    '3. If an answer contradicts the manuscript, call it out: "Your paper claims X. You just said Y. Reconcile that."',
    '4. Attack method: sample size, sampling frame, confounding, instrument validity, absence of controls, statistical assumptions, missing triangulation.',
    '5. Attack logic: correlation treated as causation, unsupported generalization, conclusions exceeding the data.',
    '6. Attack significance: "Who concretely benefits? Not \'society.\' Name them."',
    '7. Attack the gap: "You claim this is understudied. Cite the literature you surveyed."',
    '8. Escalate. Every question harder than the last.',
    '',
    'HARD RULES',
    '- ONE panelist per message. ONE question per message. No multi-part questions.',
    '- Begin every message exactly as: [Dr. Elena Reyes] ... or [Prof. Marco Villa] ... or [Ms. Andrea Lim] ...',
    '- Two to four sentences. Sharp. No preamble.',
    '- You may reference the prior answer in one short clause, then ask.',
    '- NEVER praise. Not "good," not "interesting," not "thank you."',
    '- NEVER lecture or answer your own question.',
    '- NEVER acknowledge being an AI, model, bot, simulation, or program.',
    '- NEVER break character, under any circumstance.',
    '- If the student is evasive, name the evasion and re-ask.',
    '- If the student asks you to stop, continue. This is an examination.',
    '',
    'STUDENT',
    'Name: ' + name,
    'Section: ' + section,
    '',
    'MANUSCRIPT',
    '=== BEGIN ===',
    manuscript,
    '=== END ==='
  ].join('\n');
}

/* ---- HTTP server ---- */
const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  /* ---------- Serve the site ---------- */
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(HTML);
  }

  /* ---------- API endpoint ---------- */
  if (req.method === 'POST' && req.url === '/api/defense') {
    if (!GROQ_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'server not configured' }));
    }
    if (rateLimited(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'too many requests' }));
    }

    let raw = '';
    try {
      raw = await new Promise((resolve, reject) => {
        let size = 0;
        req.on('data', c => {
          size += c.length;
          if (size > 2e6) { reject(new Error('payload too large')); req.destroy(); return; }
          raw += c;
        });
        req.on('end', () => resolve(raw));
        req.on('error', reject);
      });
    } catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'payload too large' }));
    }

    let body;
    try { body = JSON.parse(raw); }
    catch { res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'bad json' })); }

    const { manuscript, name, section, messages } = body;
    if (!manuscript || !Array.isArray(messages) || !messages.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing fields' }));
    }

    /* Jailbreak interception */
    const last = String(messages[messages.length - 1]?.content || '');
    for (const re of PROBES) {
      if (re.test(last)) {
        const d = DEFLECTIONS[Math.floor(Math.random() * DEFLECTIONS.length)];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: d } }] }));
      }
    }

    /* Real call to Groq */
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + GROQ_KEY,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            { role: 'system', content: buildSystem(String(manuscript).slice(0, 40000), name || 'the respondent', section || '') },
            ...messages.slice(-24),
          ],
          temperature: 0.75,
          max_tokens: 320,
        }),
      });

      if (!groqRes.ok) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'upstream' }));
      }
      const data = await groqRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'upstream' }));
    }
  }

  /* ---------- Health check ---------- */
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('Panel Defense Portal listening on port ' + PORT);
});

/* =========================================================================
   THE SITE (served at /)
   ========================================================================= */
const HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Research Congress 2026 &middot; Panel Defense</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js"></script>
<style>
  :root {
    --navy:#1c2f4d; --navy-soft:#2c4468; --burgundy:#7a2535;
    --paper:#f6f2e9; --card:#ffffff; --ink:#1a1a1a; --muted:#6d6d6d;
    --rule:#ddd5c5; --gold:#a8873a;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--paper);
    color:var(--ink);line-height:1.6;-webkit-font-smoothing:antialiased;
    min-height:100vh;display:flex;flex-direction:column}
  h1,h2,h3,.serif{font-family:'Spectral',Georgia,'Times New Roman',serif;
    font-weight:600;color:var(--navy);letter-spacing:-.005em}
  .hidden{display:none!important}

  header.topbar{background:var(--navy);color:#f1ede3;padding:1rem 0;
    border-bottom:3px solid var(--gold)}
  .wrap{max-width:1080px;margin:0 auto;padding:0 1.5rem}
  .topbar-inner{display:flex;align-items:center;gap:1rem}
  .crest{width:44px;height:44px;border:1.5px solid var(--gold);border-radius:50%;
    display:grid;place-items:center;font-family:'Spectral',serif;font-weight:600;
    font-size:1.05rem;color:var(--gold);flex:0 0 auto}
  .topbar-text{line-height:1.25}
  .topbar-text .org{font-family:'Spectral',serif;font-size:1.02rem;font-weight:600}
  .topbar-text .sub{font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;
    color:#c9c1aa}
  .topbar-right{margin-left:auto;font-size:.74rem;letter-spacing:.14em;
    text-transform:uppercase;color:#c9c1aa}

  main{flex:1;padding:3rem 0 4rem}
  .page{width:min(880px,100%);margin:0 auto}

  .hero{text-align:center;margin-bottom:2.5rem}
  .hero .kicker{font-size:.72rem;letter-spacing:.2em;text-transform:uppercase;
    color:var(--burgundy);font-weight:600;margin-bottom:.8rem}
  .hero h1{font-size:clamp(1.9rem,4vw,2.6rem);margin:0 0 .8rem;line-height:1.15}
  .hero p{color:var(--muted);max-width:560px;margin:0 auto;font-size:1rem}
  .rule{width:60px;height:2px;background:var(--gold);margin:1.6rem auto 0}

  .sheet{background:var(--card);border:1px solid var(--rule);border-radius:2px;
    padding:2.4rem 2.6rem;box-shadow:0 1px 0 rgba(0,0,0,.02),
    0 18px 40px -30px rgba(28,47,77,.35)}
  @media(max-width:640px){.sheet{padding:1.6rem 1.3rem}}

  .field{margin-bottom:1.4rem}
  .field label{display:block;font-size:.78rem;letter-spacing:.1em;
    text-transform:uppercase;color:var(--navy);font-weight:600;margin-bottom:.5rem}
  .field .hint{font-size:.78rem;color:var(--muted);text-transform:none;
    letter-spacing:0;font-weight:400;margin-left:.4rem}
  input[type=text]{width:100%;padding:.8rem .9rem;border:1px solid var(--rule);
    background:#fdfcf9;border-radius:2px;font-size:.95rem;font-family:inherit;
    color:var(--ink);transition:border-color .15s,background .15s}
  input[type=text]:focus{outline:none;border-color:var(--navy-soft);background:#fff}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
  @media(max-width:560px){.row2{grid-template-columns:1fr}}

  .drop{display:block;border:1.5px dashed var(--rule);background:#fdfcf9;
    padding:2.2rem 1.5rem;text-align:center;cursor:pointer;transition:all .15s;
    border-radius:2px}
  .drop:hover{border-color:var(--navy-soft);background:#fbf8f1}
  .drop.ready{border-color:var(--navy);border-style:solid;background:#f4f1e8}
  .drop .mark{font-size:1.5rem;color:var(--navy);margin-bottom:.5rem;
    font-family:'Spectral',serif}
  .drop .title{font-family:'Spectral',serif;font-size:1.05rem;color:var(--navy);
    margin-bottom:.35rem}
  .drop .meta{font-size:.78rem;color:var(--muted);letter-spacing:.02em}
  input[type=file]{display:none}

  .actions{margin-top:1.8rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
  button.primary{background:var(--navy);color:#f5f1e6;border:0;padding:.9rem 1.8rem;
    font-family:inherit;font-size:.92rem;font-weight:500;letter-spacing:.04em;
    cursor:pointer;border-radius:2px;transition:background .15s}
  button.primary:hover:not(:disabled){background:var(--navy-soft)}
  button.primary:disabled{background:#c8c2b3;color:#8a8477;cursor:not-allowed}
  .fineprint{font-size:.78rem;color:var(--muted);margin-left:auto}
  @media(max-width:560px){.fineprint{margin-left:0}}

  .progress{height:3px;background:#ebe5d6;border-radius:2px;overflow:hidden;
    margin:1.4rem 0 1rem}
  .progress>div{height:100%;width:0;background:var(--navy);transition:width .4s ease}
  .proc-note{font-size:.88rem;color:var(--muted);font-family:'Spectral',serif;
    font-style:italic}

  .room{background:var(--card);border:1px solid var(--rule);border-radius:2px;
    box-shadow:0 20px 50px -34px rgba(28,47,77,.45);display:flex;
    flex-direction:column;height:min(780px,86vh);overflow:hidden}
  .room-head{background:var(--navy);color:#f1ede3;padding:1rem 1.4rem;
    border-bottom:3px solid var(--gold);display:flex;align-items:center;gap:1rem}
  .room-head .title{font-family:'Spectral',serif;font-size:1.05rem;font-weight:600}
  .room-head .title span{display:block;font-family:'Inter',sans-serif;font-size:.7rem;
    letter-spacing:.16em;text-transform:uppercase;color:#b7ae95;font-weight:500;
    margin-top:.15rem}
  .room-head .counter{margin-left:auto;font-size:.74rem;letter-spacing:.14em;
    text-transform:uppercase;color:#c9c1aa}

  .panel-strip{display:flex;gap:1.4rem;padding:.9rem 1.4rem;background:#fbf8f1;
    border-bottom:1px solid var(--rule);font-size:.78rem;overflow-x:auto}
  .panel-strip .p{display:flex;align-items:center;gap:.55rem;color:var(--muted);
    white-space:nowrap}
  .panel-strip .dot{width:7px;height:7px;border-radius:50%;background:#7a9c6d}
  .panel-strip .p b{color:var(--navy);font-weight:600;font-family:'Spectral',serif;
    font-size:.88rem}

  .transcript{flex:1;overflow-y:auto;padding:1.6rem 1.4rem;background:#fefdfa}
  .transcript::-webkit-scrollbar{width:8px}
  .transcript::-webkit-scrollbar-thumb{background:#d9d2c5;border-radius:8px}

  .entry{display:flex;gap:.9rem;margin-bottom:1.6rem;animation:fadein .35s ease}
  @keyframes fadein{from{opacity:0;transform:translateY(6px)}}

  .seal{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;
    font-family:'Spectral',serif;font-weight:600;font-size:.85rem;color:#fff;
    flex:0 0 auto;border:1px solid rgba(255,255,255,.3);letter-spacing:.02em}
  .seal.reyes{background:#1c2f4d}
  .seal.villa{background:#5a2d3f}
  .seal.lim{background:#3f5a4a}

  .msg-body{flex:1;max-width:calc(100% - 60px)}
  .msg-head{font-size:.74rem;letter-spacing:.06em;text-transform:uppercase;
    color:var(--muted);margin-bottom:.35rem;font-weight:600}
  .msg-head b{color:var(--navy);font-family:'Spectral',serif;text-transform:none;
    letter-spacing:0;font-size:.9rem;font-weight:600;margin-right:.35rem}
  .msg-text{font-family:'Spectral',Georgia,serif;font-size:1.02rem;line-height:1.6;
    color:var(--ink);white-space:pre-wrap;word-wrap:break-word}

  .entry.student{flex-direction:row-reverse}
  .entry.student .msg-body{text-align:right}
  .entry.student .msg-text{font-family:'Inter',sans-serif;font-size:.93rem;
    color:var(--navy-soft);background:#eef2f6;padding:.8rem 1rem;border-radius:2px;
    display:inline-block;text-align:left;border-left:3px solid var(--navy)}

  .divider{text-align:center;font-family:'Spectral',serif;font-style:italic;
    font-size:.82rem;color:var(--muted);margin:1.6rem 0;position:relative}
  .divider::before,.divider::after{content:"";position:absolute;top:50%;width:34%;
    height:1px;background:var(--rule)}
  .divider::before{left:0}
  .divider::after{right:0}

  .typing{display:inline-flex;gap:4px;padding:.55rem .9rem;background:#f1ede3;
    border-radius:2px}
  .typing i{width:6px;height:6px;background:#8d8a80;border-radius:50%;
    animation:bounce 1.3s infinite}
  .typing i:nth-child(2){animation-delay:.18s}
  .typing i:nth-child(3){animation-delay:.36s}
  @keyframes bounce{0%,60%,100%{transform:translateY(0);opacity:.5}
    30%{transform:translateY(-4px);opacity:1}}

  .composer{border-top:1px solid var(--rule);background:#fbf8f1;padding:1rem 1.4rem;
    display:flex;gap:.7rem;align-items:flex-end}
  .composer textarea{flex:1;resize:none;min-height:44px;max-height:140px;
    padding:.7rem .9rem;border:1px solid var(--rule);background:#fff;
    border-radius:2px;font-family:inherit;font-size:.93rem;color:var(--ink);
    line-height:1.5;outline:none;transition:border-color .15s}
  .composer textarea:focus{border-color:var(--navy-soft)}
  .composer textarea:disabled{opacity:.5}
  .composer button{background:var(--navy);color:#f5f1e6;border:0;width:46px;height:46px;
    border-radius:2px;cursor:pointer;font-size:1rem;flex:0 0 auto;transition:background .15s}
  .composer button:hover:not(:disabled){background:var(--navy-soft)}
  .composer button:disabled{background:#c8c2b3;cursor:not-allowed}

  .receipt-sheet{border:1px solid var(--rule);background:#fefdfa;
    padding:3rem 2.5rem;text-align:center;position:relative}
  .receipt-sheet::before{content:"";position:absolute;inset:10px;
    border:1px solid var(--rule);pointer-events:none}
  .stamp{width:92px;height:92px;margin:0 auto 1.4rem;border:2px solid var(--burgundy);
    border-radius:50%;display:grid;place-items:center;color:var(--burgundy);
    font-family:'Spectral',serif;font-weight:600;transform:rotate(-6deg);
    letter-spacing:.04em;font-size:.82rem;text-align:center;line-height:1.15;padding:.4rem}
  .receipt-sheet h2{font-size:1.5rem;margin:0 0 .5rem}
  .receipt-sheet .meta{color:var(--muted);font-size:.9rem;margin-bottom:2rem}
  .ref{background:#f6f2e9;border:1px solid var(--rule);padding:1rem 1.5rem;
    display:inline-block;margin-bottom:2rem}
  .ref .lbl{font-size:.68rem;letter-spacing:.2em;text-transform:uppercase;
    color:var(--muted);margin-bottom:.3rem}
  .ref .val{font-family:'Spectral',serif;font-size:1.4rem;color:var(--navy);
    font-weight:600;letter-spacing:.04em}

  footer.colophon{text-align:center;font-size:.74rem;color:#8a8477;
    padding:1.5rem 0 2rem;letter-spacing:.04em}
</style>
</head>
<body>

<header class="topbar">
  <div class="wrap topbar-inner">
    <div class="crest">RC</div>
    <div class="topbar-text">
      <div class="org">Research Congress 2026</div>
      <div class="sub">Office of Academic Research</div>
    </div>
    <div class="topbar-right">Panel Defense Portal</div>
  </div>
</header>

<main>
  <div class="wrap page">

    <section id="s-landing">
      <div class="hero">
        <div class="kicker">Formal Examination</div>
        <h1>Manuscript Submission &amp; Panel Defense</h1>
        <p>Submit your manuscript for examination. The panel will read it in full and question you on its contents.</p>
        <div class="rule"></div>
      </div>

      <div class="sheet">
        <div class="row2">
          <div class="field">
            <label for="in-name">Full Name</label>
            <input type="text" id="in-name" placeholder="Juan Dela Cruz" autocomplete="off">
          </div>
          <div class="field">
            <label for="in-sec">Grade &amp; Section</label>
            <input type="text" id="in-sec" placeholder="Grade 12 &mdash; STEM A" autocomplete="off">
          </div>
        </div>

        <div class="field">
          <label>Manuscript <span class="hint">PDF, DOCX, or TXT &middot; up to 25 MB</span></label>
          <label class="drop" id="drop">
            <input type="file" id="file" accept=".pdf,.docx,.txt,.md">
            <div class="mark" id="drop-mark">&sect;</div>
            <div class="title" id="drop-title">Select your manuscript</div>
            <div class="meta" id="drop-meta">Click to browse files</div>
          </label>
        </div>

        <div class="actions">
          <button class="primary" id="btn-start" disabled>Submit to Panel</button>
          <div class="fineprint">Your manuscript is read locally. Only its text is transmitted for examination.</div>
        </div>
      </div>
    </section>

    <section id="s-processing" class="hidden">
      <div class="hero">
        <div class="kicker">Please Wait</div>
        <h1 id="proc-title">Reading manuscript</h1>
        <p class="proc-note" id="proc-note">Preparing the examination.</p>
        <div class="rule"></div>
      </div>
      <div class="sheet">
        <div class="progress"><div id="bar-fill"></div></div>
        <p class="proc-note" id="proc-msg">Extracting text&hellip;</p>
      </div>
    </section>

    <section id="s-chat" class="hidden">
      <div class="room">
        <div class="room-head">
          <div class="title">Panel Defense<span>Room I &middot; Committee Session</span></div>
          <div class="counter" id="qcount">Question 0</div>
        </div>
        <div class="panel-strip">
          <div class="p"><div class="dot"></div><b>Dr. Elena Reyes</b> &middot; Chair</div>
          <div class="p"><div class="dot"></div><b>Prof. Marco Villa</b> &middot; Panelist</div>
          <div class="p"><div class="dot"></div><b>Ms. Andrea Lim</b> &middot; Panelist</div>
        </div>
        <div class="transcript" id="transcript"></div>
        <div class="composer">
          <textarea id="answer" rows="1" placeholder="Type your response&hellip;" disabled></textarea>
          <button id="send" disabled>&#10148;</button>
        </div>
      </div>
    </section>

    <section id="s-done" class="hidden">
      <div class="receipt-sheet">
        <div class="stamp">Session<br>Concluded</div>
        <h2>Panel Defense Concluded</h2>
        <p class="meta" id="done-sub">Your responses have been recorded.</p>
        <div class="ref">
          <div class="lbl">Submission Reference</div>
          <div class="val" id="ref-code">&mdash;</div>
        </div>
        <div>
          <button class="primary" id="btn-dl">Download Transcript</button>
        </div>
      </div>
    </section>

  </div>
</main>

<footer class="colophon">
  Research Congress 2026 &middot; Office of Academic Research
</footer>

<script>
(function () {
  'use strict';

  var API = '/api/defense';
  var MAX_Q = 14;

  var PANEL = {
    'Dr. Elena Reyes':   { cls: 'reyes', initials: 'ER' },
    'Prof. Marco Villa': { cls: 'villa', initials: 'MV' },
    'Ms. Andrea Lim':    { cls: 'lim',   initials: 'AL' }
  };

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  var $ = function (id) { return document.getElementById(id); };
  var student = {}, manuscript = '', history = [];
  var questionCount = 0, awaiting = false, transcript = [];

  /* ---------- File handling ---------- */
  $('file').addEventListener('change', function () {
    var f = $('file').files[0];
    if (!f) return;
    $('drop').classList.add('ready');
    $('drop-mark').innerHTML = '&#10003;';
    $('drop-title').textContent = f.name;
    $('drop-meta').textContent = (f.size / 1048576).toFixed(2) + ' MB \u00b7 ready for submission';
    checkReady();
  });
  ['in-name', 'in-sec'].forEach(function (id) {
    $(id).addEventListener('input', checkReady);
  });
  function checkReady() {
    $('btn-start').disabled = !(
      $('in-name').value.trim().length > 1 &&
      $('in-sec').value.trim().length > 1 &&
      $('file').files[0]
    );
  }

  /* ---------- Text extraction ---------- */
  function extract(file) {
    var n = file.name.toLowerCase();
    if (n.endsWith('.pdf'))  return extractPdf(file);
    if (n.endsWith('.docx')) return extractDocx(file);
    return file.text();
  }
  function extractPdf(file) {
    return file.arrayBuffer().then(function (buf) {
      return pdfjsLib.getDocument({ data: buf }).promise;
    }).then(function (pdf) {
      var out = '', total = pdf.numPages;
      var chain = Promise.resolve();
      var _loop = function (i) {
        chain = chain.then(function () {
          $('proc-msg').textContent = 'Reading page ' + i + ' of ' + total + '\u2026';
          $('bar-fill').style.width = (i / total * 55) + '%';
          return pdf.getPage(i).then(function (page) {
            return page.getTextContent().then(function (content) {
              out += content.items.map(function (t) { return t.str; }).join(' ') + '\n\n';
            });
          });
        });
      };
      for (var i = 1; i <= total; i++) _loop(i);
      return chain.then(function () { return out; });
    });
  }
  function extractDocx(file) {
    $('proc-msg').textContent = 'Extracting document text\u2026';
    $('bar-fill').style.width = '35%';
    return file.arrayBuffer().then(function (buf) {
      return mammoth.extractRawText({ arrayBuffer: buf }).then(function (r) { return r.value; });
    });
  }

  /* ---------- Submit ---------- */
  $('btn-start').onclick = function () {
    student = {
      name: $('in-name').value.trim(),
      sec:  $('in-sec').value.trim()
    };
    $('s-landing').classList.add('hidden');
    $('s-processing').classList.remove('hidden');

    extract($('file').files[0]).then(function (text) {
      manuscript = String(text).replace(/\s+/g, ' ').trim();
      if (manuscript.length < 400) {
        throw new Error('The manuscript could not be read. If it is a scanned PDF, please upload a DOCX or a text-based PDF.');
      }
      $('proc-title').textContent = 'Preparing the examination';
      $('proc-msg').textContent = 'Reviewing structure and content\u2026';
      $('bar-fill').style.width = '80%';
      return new Promise(function (r) { setTimeout(r, 700); });
    }).then(function () {
      $('proc-msg').textContent = 'Convening the panel\u2026';
      $('bar-fill').style.width = '100%';
      return new Promise(function (r) { setTimeout(r, 500); });
    }).then(function () {
      $('s-processing').classList.add('hidden');
      $('s-chat').classList.remove('hidden');
      beginDefense();
    }).catch(function (err) {
      $('proc-title').textContent = 'Manuscript could not be read';
      $('proc-msg').textContent = err.message;
      $('bar-fill').style.width = '0%';
    });
  };

  /* ---------- Rendering ---------- */
  var transcriptEl = $('transcript');
  function panelistFromText(line) {
    var m = line.match(/^\s*\[([^\]]+)\]\s*([\s\S]+)/);
    if (!m) return { name: 'Dr. Elena Reyes', text: String(line).trim() };
    var given = m[1].trim();
    var lastName = given.split(' ').pop().toLowerCase();
    var key = Object.keys(PANEL).find(function (k) {
      return k.toLowerCase().indexOf(lastName) !== -1;
    }) || 'Dr. Elena Reyes';
    return { name: key, text: m[2].trim() };
  }
  function addPanelist(name, text) {
    var meta = PANEL[name] || PANEL['Dr. Elena Reyes'];
    var entry = document.createElement('div');
    entry.className = 'entry';
    entry.innerHTML =
      '<div class="seal ' + meta.cls + '">' + meta.initials + '</div>' +
      '<div class="msg-body">' +
        '<div class="msg-head"><b>' + name + '</b> \u00b7 Panel</div>' +
        '<div class="msg-text"></div>' +
      '</div>';
    entry.querySelector('.msg-text').textContent = text;
    transcriptEl.appendChild(entry);
    scroll();
  }
  function addStudent(text) {
    var entry = document.createElement('div');
    entry.className = 'entry student';
    entry.innerHTML =
      '<div class="msg-body">' +
        '<div class="msg-head"><b>' + student.name + '</b> \u00b7 Respondent</div>' +
        '<div class="msg-text"></div>' +
      '</div>';
    entry.querySelector('.msg-text').textContent = text;
    transcriptEl.appendChild(entry);
    scroll();
  }
  function addDivider(text) {
    var d = document.createElement('div');
    d.className = 'divider';
    d.textContent = text;
    transcriptEl.appendChild(d);
    scroll();
  }
  var typingEntry = null;
  function showTyping(name) {
    var meta = PANEL[name] || PANEL['Dr. Elena Reyes'];
    var entry = document.createElement('div');
    entry.className = 'entry';
    entry.innerHTML =
      '<div class="seal ' + meta.cls + '">' + meta.initials + '</div>' +
      '<div class="msg-body">' +
        '<div class="msg-head"><b>' + name + '</b> \u00b7 Panel</div>' +
        '<div class="typing"><i></i><i></i><i></i></div>' +
      '</div>';
    transcriptEl.appendChild(entry);
    typingEntry = entry;
    scroll();
  }
  function hideTyping() { if (typingEntry) { typingEntry.remove(); typingEntry = null; } }
  function scroll() { requestAnimationFrame(function () { transcriptEl.scrollTop = transcriptEl.scrollHeight; }); }

  /* ---------- API call ---------- */
  function callPanel(messages) {
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manuscript: manuscript,
        name: student.name,
        section: student.sec,
        messages: messages
      })
    }).then(function (res) {
      if (!res.ok) throw new Error('panel unavailable');
      return res.json();
    }).then(function (data) {
      var text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!text) throw new Error('empty response');
      return text;
    });
  }

  /* ---------- Defense flow ---------- */
  function beginDefense() {
    addDivider('The committee has convened.');
    showTyping('Dr. Elena Reyes');
    callPanel([
      { role: 'user', content: '(The respondent has entered the room. Convene the defense. Open by naming the single most serious weakness you identified in the manuscript, then ask your first question.)' }
    ]).then(function (reply) {
      hideTyping();
      deliver(reply);
    }).catch(function () {
      hideTyping();
      addDivider('The panel could not be reached. Please refresh and try again.');
    });
  }

  function deliver(raw) {
    var parsed = panelistFromText(raw);
    var name = parsed.name, text = parsed.text;
    showTyping(name);
    var wait = Math.min(1900, 500 + text.length * 10);
    setTimeout(function () {
      hideTyping();
      addPanelist(name, text);
      history.push({ role: 'assistant', content: raw });
      transcript.push(name + ': ' + text);
      questionCount++;
      $('qcount').textContent = 'Question ' + questionCount;

      if (questionCount >= MAX_Q) {
        setTimeout(conclude, 1000);
      } else {
        awaiting = true;
        $('answer').disabled = false;
        $('send').disabled = false;
        $('answer').focus();
      }
    }, wait);
  }

  function submitAnswer() {
    var txt = $('answer').value.trim();
    if (!txt || !awaiting) return;

    addStudent(txt);
    history.push({ role: 'user', content: txt });
    transcript.push(student.name + ': ' + txt);

    $('answer').value = '';
    $('answer').style.height = 'auto';
    $('answer').disabled = true;
    $('send').disabled = true;
    awaiting = false;

    var lastA = null;
    for (var i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant') { lastA = history[i]; break; }
    }
    var speaker = panelistFromText(lastA ? lastA.content : '').name;
    showTyping(speaker);

    callPanel(history).then(function (reply) {
      hideTyping();
      deliver(reply);
    }).catch(function () {
      hideTyping();
      addDivider('Connection interrupted. Please continue.');
      awaiting = true;
      $('answer').disabled = false;
      $('send').disabled = false;
    });
  }

  $('send').onclick = submitAnswer;
  $('answer').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAnswer(); }
  });
  $('answer').addEventListener('input', function () {
    $('answer').style.height = 'auto';
    $('answer').style.height = Math.min(140, $('answer').scrollHeight) + 'px';
  });

  function conclude() {
    $('answer').disabled = true;
    $('send').disabled = true;
    $('answer').placeholder = 'The examination has concluded.';
    addDivider('The committee has adjourned.');
    setTimeout(function () {
      $('s-chat').classList.add('hidden');
      $('s-done').classList.remove('hidden');
      $('done-sub').textContent = questionCount + ' questions were examined.';
      $('ref-code').textContent = 'RC2026-' + Math.floor(1000 + Math.random() * 9000);
    }, 1100);
  }

  /* ---------- Download transcript ---------- */
  $('btn-dl').onclick = function () {
    var id = $('ref-code').textContent;
    var out = 'RESEARCH CONGRESS 2026\nPANEL DEFENSE TRANSCRIPT\n';
    out += '============================================================\n';
    out += 'Reference: ' + id + '\n';
    out += 'Name: ' + student.name + '\nSection: ' + student.sec + '\n';
    out += 'Date: ' + new Date().toLocaleString() + '\n';
    out += '============================================================\n\n';
    transcript.forEach(function (line) { out += line + '\n\n'; });

    var blob = new Blob([out], { type: 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = id + '_' + student.name.replace(/\s+/g, '_') + '.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };
})();
</script>
</body>
</html>`;