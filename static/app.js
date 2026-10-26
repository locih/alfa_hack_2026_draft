/* Умный кредитный кабинет — UI без сборки. Два кабинета (клиент / банк) на одном API. */
(() => {
"use strict";

// ---------- утилиты ----------
class Raw { constructor(s) { this.s = s; } }
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const raw = (s) => new Raw(s);
const part = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join("") : esc(v));
const h = (s, ...v) => new Raw(s.reduce((a, x, i) => a + x + (i < v.length ? part(v[i]) : ""), ""));

const rub = (n) => (n == null ? "—" : Math.round(n).toLocaleString("ru-RU") + "\u00a0₽");
const pct = (n) => (n == null ? "—" : Number(n).toFixed(1).replace(".", ",") + " %");
const dt = (s) => new Date(s).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const dateOnly = (s) => new Date(s).toLocaleDateString("ru-RU");
function ago(s) {
  const m = Math.max(0, Math.round((Date.now() - new Date(s)) / 60000));
  if (m < 1) return "только что";
  if (m < 60) return m + " мин назад";
  if (m < 1440) return Math.round(m / 60) + " ч назад";
  return Math.round(m / 1440) + " дн назад";
}
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const root = () => $("#app");

let toastTimer;
function toast(msg, bad) {
  const t = $("#toast");
  t.textContent = msg; t.className = "show" + (bad ? " bad" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ""), 3500);
}

// ---------- состояние и API ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* приватный режим */ } },
};
function readUser() { try { return JSON.parse(store.get("user") || "null"); } catch { return null; } }   // испорченный localStorage не должен ломать сайт
let session = { token: store.get("token"), user: readUser() };
if (!session.user) session.token = null;
let poll = null;

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(session.token ? { Authorization: "Bearer " + session.token } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (res.status === 401 && !opts.noAuthRedirect) { logout(true); throw new Error("Требуется вход"); }
  if (!res.ok) {
    const d = data && data.detail;
    throw new Error(typeof d === "string" ? d : Array.isArray(d) ? "Проверьте заполнение полей" : "Ошибка " + res.status);
  }
  return data;
}

function logout(silent) {
  if (!silent && session.token) api("/auth/logout", { method: "POST", noAuthRedirect: true }).catch(() => {});
  session = { token: null, user: null }; store.set("token", null); store.set("user", null);
  stopPoll(); location.hash = "#/login";
}
function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

// ---------- рендер ----------
// суммы: цифры «прилетают» слева направо один раз при входе на экран (без счётчиков)
function animateCounts(scope) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  scope.querySelectorAll("[data-count]:not([data-animated])").forEach((el, i) => {
    el.dataset.animated = "1";
    const text = el.textContent; let k = 0;
    el.innerHTML = Array.from(text).map((ch) => ch.trim() === "" ? ch : `<span class="d" style="--k:${k++};--g:${i}">${esc(ch)}</span>`).join("");
  });
}
let lastHash = null;
// тема: тёмная по умолчанию (атрибут в index.html), выбор пользователя хранится локально
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const themeNow = () => document.documentElement.dataset.theme === "dark" ? "dark" : "light";
function applyTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem("theme", t); } catch { /* приватный режим */ } $$(".theme-btn").forEach((b) => { b.innerHTML = t === "dark" ? SUN : MOON; b.title = t === "dark" ? "Светлая тема" : "Тёмная тема"; }); }
try { const t = localStorage.getItem("theme"); if (t === "dark" || t === "light") document.documentElement.dataset.theme = t; } catch { /* приватный режим */ }
const themeBtn = () => raw(`<button class="theme-btn" data-act="theme" aria-label="Переключить тему" title="${themeNow() === "dark" ? "Светлая тема" : "Тёмная тема"}">${themeNow() === "dark" ? SUN : MOON}</button>`);
function render(view) {
  const keep = {};
  root().querySelectorAll("[id]").forEach((el) => { if ("value" in el) keep[el.id] = { v: el.value, c: el.checked, f: el === document.activeElement }; });
  root().innerHTML = view.s;
  for (const [id, st] of Object.entries(keep)) {
    const el = document.getElementById(id);
    if (!el || el.dataset.fresh) continue;
    if (el.type === "checkbox") el.checked = st.c; else el.value = st.v;
    if (st.f) el.focus();
  }
  // моушн: каскадное появление при переходе между экранами (тихие перерисовки поллинга не анимируем)
  if (location.hash !== lastHash) {
    lastHash = location.hash;
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    const r = root();
    r.classList.remove("enter", "leaving"); void r.offsetWidth;
    // каскад только для того, что видно без прокрутки; остальное появляется сразу, чтобы при скролле не было пустых мест
    const vh = window.innerHeight || 800;
    r.querySelectorAll(".acc, .card, .tile, .prod, .roles h2, table.t tbody tr, .bars .fill").forEach((el, i) => {
      const top = el.getBoundingClientRect().top;
      if (top < vh) { el.classList.add("cascade"); el.style.setProperty("--i", Math.min(i, 6)); } else { el.classList.remove("cascade"); el.style.removeProperty("--i"); }
    });
    r.classList.add("enter");
    clearTimeout(render._t); render._t = setTimeout(() => r.classList.remove("enter"), 3600);
    animateCounts(r);
  }
}

// Глоссарий: термин подчёркнут, при наведении или фокусе (клавиатура, касание) показывается пояснение
const GLOSS = {
  "ставка": "Процент годовых, по которому банк начисляет плату за пользование деньгами. Чем выше ставка, тем больше переплата.",
  "ключевая ставка": "Главная ставка Банка России. От неё банки отталкиваются, когда назначают ставки по кредитам.",
  "аннуитет": "Равные ежемесячные платежи весь срок. В начале в платеже больше процентов, к концу — больше основного долга.",
  "платёж": "Сколько нужно вносить каждый месяц: часть идёт на проценты, часть — на возврат взятой суммы.",
  "переплата": "Сколько вы заплатите сверх суммы кредита: это проценты за весь срок.",
  "основной долг": "Часть платежа, которая уменьшает сумму, взятую в долг.",
  "проценты": "Плата банку за пользование деньгами; считается от остатка долга.",
  "остаток долга": "Сколько ещё нужно вернуть банку (без процентов, которые начислятся позже).",
  "график платежей": "Расписание: когда и сколько платить каждый месяц, сколько из платежа идёт на проценты и на основной долг.",
  "обеспечение": "То, что снижает риск банка: залог или поручительство. С обеспечением ставка ниже, без него — выше.",
  "залог": "Имущество (оборудование, транспорт, недвижимость), которое остаётся в залоге у банка до погашения. Если платить не получится, банк может его продать.",
  "поручительство": "Другой человек обязуется вернуть кредит, если вы не сможете. Для ООО это обычно собственники бизнеса, для ИП — третье лицо.",
  "простая электронная подпись": "Подтверждение кодом, которое заменяет подпись от руки. В демо код показан на экране.",
  "договор": "Документ с условиями кредита: сумма, срок, ставка, график платежей и права сторон.",
  "согласие на обработку данных": "Разрешение банку обрабатывать данные компании и запрашивать кредитную историю в бюро (152-ФЗ). Без него банк не может проверить заявку.",
  "овердрафт": "Лимит на расчётном счёте: можно уйти «в минус» в пределах лимита и быстро вернуть, чтобы закрыть кассовый разрыв.",
  "лимит": "Максимальная сумма, которой вы можете пользоваться. Платите проценты только за использованную часть.",
  "льготная программа": "Государственная поддержка МСП: ставка ниже рыночной (ключевая + 3 п.п.) в первый год. Доступна не всем отраслям.",
  "досрочное погашение": "Можно вернуть кредит раньше срока без штрафа: проценты платятся только за время пользования.",
};
const T = (key, text) => raw(`<span class="term" tabindex="0" role="note" data-tip="${esc(GLOSS[key] || "")}">${esc(text || key)}</span>`);

// иконки продуктов — @alfalab/icons (MIT), сконвертированы tools/alfa_icon.py
const PRODUCT_ICON = {
  working: raw('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" role="img"><path d="M5 4a2 2 0 00-2 2h15a3 3 0 013 3v8a2 2 0 002-2V6a2 2 0 00-2-2H5z"/><path d="M1 10a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2H3a2 2 0 01-2-2v-8zm11 4a2 2 0 11-4 0 2 2 0 014 0zm-6 4H3v-3l3 3zm11-8h-3l3 3v-3z" fill-rule="evenodd" clip-rule="evenodd"/></svg>'),
  overdraft: raw('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" role="img"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zm0-13.5A3.5 3.5 0 008.5 12H7a5 5 0 018.818-3.228L16 7.5h1V11h-3.5v-1l1.24-.177A3.494 3.494 0 0012 8.5zm3.5 3.5a3.5 3.5 0 01-6.24 2.177L10.5 14v-1H7v3.5h1l.182-1.272A5 5 0 0017 12h-1.5z" fill-rule="evenodd" clip-rule="evenodd"/></svg>'),
  development: raw('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" role="img"><path d="M20 3a1 1 0 011 1v17H3v-7.339a3 3 0 011.661-2.684l3.616-1.729A.5.5 0 019 9.695V11.8c0 .153.067.275.2.2l4.054-2.886A.5.5 0 0114 9.55V12h3V4a1 1 0 011-1h2z"/></svg>'),
  preferential: raw('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" role="img"><path d="M11.063 3.505c.324-.866 1.55-.866 1.873 0l1.794 4.798a1 1 0 00.893.649l5.118.223c.924.04 1.302 1.206.578 1.782l-4.008 3.189a1 1 0 00-.341 1.05l1.369 4.935c.247.892-.745 1.612-1.516 1.102l-4.271-2.827a1 1 0 00-1.104 0l-4.272 2.827c-.77.51-1.762-.21-1.515-1.102l1.368-4.936a1 1 0 00-.34-1.05l-4.01-3.188c-.723-.576-.344-1.741.58-1.782l5.117-.223a1 1 0 00.893-.65l1.794-4.797z"/></svg>')
};

function chip(code, title) {
  const m = {
    VERIFICATION: ["info pulse", title], DECISIONING: ["info pulse", title], DISBURSING: ["info pulse", title],
    MANUAL_REVIEW: ["info", title], AWAITING_DOCS: ["warn", title], OFFER_READY: ["ok", title], AWAITING_SIGNATURE: ["warn", title],
    DISBURSED: ["ok", title], DECLINED: ["bad", title], WITHDRAWN: ["", title], EXPIRED: ["", title], DRAFT: ["", title],
  }[code] || ["", title];
  return h`<span class="chip ${m[0]}"><span class="dot"></span>${m[1]}</span>`;
}

function topbar(extra = "") {
  const u = session.user;
  const bank = u.role !== "client";
  return h`<header class="topbar"><div class="in">
    <a class="brand" href="#/${bank ? "bank" : "client"}"><i></i><span>${bank ? "Рабочее место банка" : "Кредитный кабинет"} <small>· МСБ</small></span></a>
    ${raw(extra)}<span class="spacer"></span>${themeBtn()}
    ${bank ? "" : h`<button class="bell" data-act="notif" aria-label="Уведомления" aria-haspopup="dialog">${BELL}${notifUnread() ? h`<span class="nbadge">${notifUnread()}</span>` : ""}</button>`}
    <a class="who" href="#/${bank ? "bank" : "client"}" title="${bank ? "Перейти в очередь заявок" : "Перейти в личный кабинет"}"><b>${u.name}</b><span class="muted small">${bank ? (u.role === "admin" ? "администратор стенда" : "кредитный аналитик") : "Личный кабинет"} →</span></a>
    <button class="btn sm" data-act="logout">Выйти</button></div></header>`.s;
}

// ---------- вход ----------
async function viewLogin() {
  document.title = "Умный кредитный кабинет";
  stopPoll();
  const d = await api("/auth/demo-users", { noAuthRedirect: true }).catch(() => null);      // null — демо-режим выключен (DEMO_MODE=0)
  const users = d ? d.users : [];
  const av = (n) => n.replace(/[«»"]/g, "").split(" ").filter((w) => w.length > 1).slice(0, 2).map((w) => w[0]).join("");
  const arrow = h`<svg class="arrow" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 5.5 20 12l-6.5 6.5-1.4-1.4 4.1-4.1H4v-2h12.2l-4.1-4.1 1.4-1.4z"/></svg>`;
  const acc = (u, i) => h`<button class="rcard ${u.role === "client" ? "" : "bank"} ${u.login === "lesnoy" ? "first" : ""}" data-act="demo-login" data-login="${u.login}">
      ${u.login === "lesnoy" ? raw('<span class="chip accent start">Начните отсюда</span>') : ""}
      <span class="av">${av(u.name)}</span><b>${u.name}</b><small>${u.login === "lesnoy" ? "Главный сценарий: банк не говорит «нет», а предлагает условия, при которых будет «да» — и объясняет почему" : u.hint}</small><span class="go">Войти ${arrow}</span></button>`;
  const ORDER = ["lesnoy", "sever", "gromov", "stroy"];            // первым — сценарий со встречным предложением: главная идея продукта
  const clients = users.filter((u) => u.role === "client").sort((a, b) => (ORDER.indexOf(a.login) + 1 || 99) - (ORDER.indexOf(b.login) + 1 || 99)), bank = users.filter((u) => u.role !== "client");
  render(h`<div class="landing">
    <header class="hero-dark"><div class="in">
      <div class="row between"><div class="login-mark light"><i></i><span>Кредитный кабинет <small>· малый бизнес</small></span></div><span class="theme-wrap light">${themeBtn()}</span></div>
      <div class="hero-grid">
        <div class="hero-text">
          <h1>Кредит для бизнеса без лишних шагов</h1>
          <p class="lead">Подбор продукта по задаче, заявка за три минуты, живой статус и понятное решение. Для банка — та же заявка, скоринг по факторам и ручной разбор в одном окне.</p>
          <div class="tags"><span class="chip dark">Прототип · Альфа-Будущее Хакатон 2026</span><span class="chip dark">Данные синтетические</span><span class="chip dark">БКИ, ЕГРЮЛ, ФНС — моки</span></div>
          <a class="btn primary lg" href="#roles" data-act="scroll-roles">Выбрать роль и войти</a>
        </div>
        <div class="hero-art" aria-hidden="true"><img src="img/hero-logo.webp" alt="" width="1024" height="1024" decoding="async" onerror="this.remove()"></div>
      </div>
    </div></header>
    <section class="sheet" id="roles"><div class="in">
      <div class="sec-head"><h2>Выберите роль</h2>
        ${d ? h`<div class="ptabs" role="tablist"><button class="ptab sel" role="tab" data-act="role-tab" data-k="client">Клиенты</button><button class="ptab" role="tab" data-act="role-tab" data-k="bank">Банк</button></div>` : ""}</div>
      ${d ? h`<div class="role-group" data-group="client"><div class="grid g4 role-cards">${clients.map(acc)}</div></div>
      <div class="role-group" data-group="bank" hidden><div class="grid g4 role-cards">${bank.map(acc)}</div></div>` : h`<div class="notice plate mb">Демо-режим выключен. Войдите под своей учётной записью.</div>`}
      <details class="login-form" ${d ? "" : "open"}><summary>Войти по логину и паролю</summary>
        <form data-act="login-form" class="mt">
          <div class="field"><label for="lg">Логин</label><input id="lg" type="text" autocomplete="username"></div>
          <div class="field"><label for="pw">Пароль</label><input id="pw" type="password" autocomplete="current-password"></div>
          <button class="btn primary" type="submit">Войти</button>
          ${d ? h`<p class="hint">Для всех демо-учёток пароль: <code>${d.password}</code></p>` : ""}</form></details>
      <p class="foot">Подписание и выдача имитируются, реальных операций нет. Учебный прототип команды, не сервис банка.</p>
    </div></section></div>`);
}
async function doLogin(login, password) {
  try {
    const r = await api("/auth/login", { body: { login, password }, noAuthRedirect: true });
    session = { token: r.token, user: r.user }; store.set("token", r.token); store.set("user", JSON.stringify(r.user));
    location.hash = r.user.role === "client" ? "#/client" : "#/bank";
  } catch (e) { toast(e.message, true); }
}

// ---------- клиент: главная ----------
function monthOf(i) { const now = new Date(); return new Date(now.getFullYear(), now.getMonth() - 11 + i, 1); }
function monthName(dt, long = true) { return dt.toLocaleString("ru", long ? { month: "long", year: "numeric" } : { month: "short" }).replace(/^./, (c) => c.toUpperCase()); }
function turnoverChart(receipts) {
  const max = Math.max(...receipts) * 1.1, W = 600, H = 150, bw = 34, gap = (W - 12 * bw) / 11;
  const avg = receipts.reduce((a, b) => a + b, 0) / receipts.length;
  return h`<div class="chart-wrap">
    <div class="chart-head"><div class="chart-info"><span class="muted small">Наведите на столбик · пунктир — среднее ${rub(Math.round(avg))} · красным — падение ≥ 20 % к прошлому месяцу</span></div>
      <button class="btn sm" data-act="receipts-details">Детали поступлений</button></div>
    <svg class="chart" viewBox="0 0 ${W} ${H + 22}" role="img" aria-label="Поступления на счёт за 12 месяцев"><defs><linearGradient id="vgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9a85ff"/><stop offset="1" stop-color="#5a3df0"/></linearGradient><linearGradient id="ggrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c6ff4d"/><stop offset="1" stop-color="#8fd400"/></linearGradient><linearGradient id="rgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff6b5e"/><stop offset="1" stop-color="#d61f12"/></linearGradient></defs>
    <line class="r-avg" x1="0" x2="${W}" y1="${H - (avg / max) * H}" y2="${H - (avg / max) * H}"/>
    ${receipts.map((v, i) => {
      const dt = monthOf(i), bh = Math.max(3, (v / max) * H), x = i * (bw + gap), prev = i ? receipts[i - 1] : null;
      return h`<g class="bar-g" tabindex="0" data-i="${i}" data-v="${v}" data-m="${monthName(dt)}" data-prev="${prev ?? ""}" data-avg="${Math.round(avg)}"><rect class="bar ${i === 11 ? "now" : prev && v < prev * 0.8 ? "drop" : v < avg ? "low" : ""}" x="${x}" y="${H - bh}" width="${bw}" height="${bh}" rx="5"></rect>
        <rect class="bar-hit" x="${x - gap / 2}" y="0" width="${bw + gap}" height="${H + 22}"></rect>
        <text x="${x + bw / 2}" y="${H + 15}" text-anchor="middle">${monthName(dt, false)}</text></g>`;
    })}</svg></div>`;
}
function chartReset(wrap) {
  wrap.classList.remove("hovering"); wrap.querySelectorAll(".bar-g.on").forEach((x) => x.classList.remove("on"));
  wrap.querySelector(".chart-info").innerHTML = h`<span class="muted small">Наведите на столбик, чтобы увидеть месяц</span>`.s;
}
function chartShow(wrap, g) {
  wrap.querySelectorAll(".bar-g.on").forEach((x) => x.classList.remove("on")); g.classList.add("on"); wrap.classList.add("hovering");
  const v = +g.dataset.v, prev = g.dataset.prev === "" ? null : +g.dataset.prev, avg = +g.dataset.avg;
  const d = prev ? Math.round((v - prev) / prev * 100) : null, da = Math.round((v - avg) / avg * 100);
  wrap.querySelector(".chart-info").innerHTML = h`<b>${g.dataset.m}</b><span class="chart-sum">${rub(v)}</span>
    <span class="chart-delta ${d == null ? "" : d >= 0 ? "up" : "down"}">${d == null ? "первый месяц" : (d >= 0 ? "+" : "") + d + " % к прошлому"}</span>
    <span class="chart-delta ${da >= 0 ? "up" : "down"}">${(da >= 0 ? "+" : "") + da + " % к среднему"}</span>`.s;
}
document.addEventListener("mouseover", (e) => {
  const wrap = e.target.closest?.(".chart-wrap"); if (!wrap) return;
  const g = e.target.closest(".bar-g"); if (g) chartShow(wrap, g); else if (!e.target.closest(".chart-head")) chartReset(wrap);
});
document.addEventListener("mouseout", (e) => {
  const wrap = e.target.closest?.(".chart-wrap"); if (!wrap) return;
  if (!e.relatedTarget || !wrap.contains(e.relatedTarget)) chartReset(wrap);   // ушли за пределы диаграммы
});
document.addEventListener("focusin", (e) => { const g = e.target.closest?.(".bar-g"); if (g) chartShow(g.closest(".chart-wrap"), g); });
document.addEventListener("focusout", (e) => { const wrap = e.target.closest?.(".chart-wrap"); if (wrap && !(e.relatedTarget && wrap.contains(e.relatedTarget))) chartReset(wrap); });

// детализация поступлений: операции генерируются на фронте детерминированно из суммы месяца (демо; в API банка их пока нет)
const PAYERS = ["ООО «Ромашка»", "ИП Петров А. В.", "ООО «ТехноСнаб»", "АО «Логистика Плюс»", "ООО «Кедр-Снаб»", "ИП Сидорова М. К.", "ООО «СтройМастер»", "ООО «Вега Маркет»", "ИП Лебедева О. Н.", "ООО «Северный ветер»"];
const PURPOSES_IN = ["Оплата по счёту", "Оплата по договору поставки", "Предоплата за услуги", "Возврат аванса", "Оплата за товар по УПД", "Эквайринг, выручка за день"];
function receiptsOps(i, total) {
  let seed = (i + 1) * 7919 + Math.round(total / 1000); const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const n = 6 + Math.floor(rnd() * 5), weights = Array.from({ length: n }, () => 0.4 + rnd()), sum = weights.reduce((a, b) => a + b, 0);
  const dt = monthOf(i), days = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
  const ops = weights.map((w, k) => ({ date: new Date(dt.getFullYear(), dt.getMonth(), 1 + Math.floor(rnd() * days)), payer: PAYERS[Math.floor(rnd() * PAYERS.length)], purpose: PURPOSES_IN[Math.floor(rnd() * PURPOSES_IN.length)], amount: Math.round(total * w / sum / 100) * 100 }));
  ops.sort((a, b) => a.date - b.date); const diff = total - ops.reduce((a, o) => a + o.amount, 0); ops[ops.length - 1].amount += diff;
  return ops;
}
let receiptsMonth = 11;
// «Детали поступлений»: период выбирается календарём (от — до), пресетами или по месяцу
const isoDay = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
let receiptsRange = null;
function showReceipts(receipts, month = 11, range = null) {
  receiptsMonth = month; document.getElementById("modal")?.remove();
  const today = new Date(), minD = monthOf(0), maxD = today;
  if (!range) { const dt = monthOf(month); range = { from: dt, to: new Date(Math.min(maxD, new Date(dt.getFullYear(), dt.getMonth() + 1, 0))) }; }
  receiptsRange = range;
  const inRange = (d) => d >= range.from && d <= new Date(range.to.getFullYear(), range.to.getMonth(), range.to.getDate(), 23, 59, 59);
  const ops = []; receipts.forEach((v, i) => { const dt = monthOf(i), end = new Date(dt.getFullYear(), dt.getMonth() + 1, 0); if (end >= range.from && dt <= range.to) ops.push(...receiptsOps(i, v).filter((o) => inRange(o.date))); });
  ops.sort((x, y) => x.date - y.date);
  const total = ops.reduce((t, o) => t + o.amount, 0), days = Math.round((range.to - range.from) / 864e5) + 1;
  const preset = (months) => { const to = maxD, from = new Date(to.getFullYear(), to.getMonth() - months + 1, 1); return { from: from < minD ? minD : from, to }; };
  const presets = [["m", "Месяц", 1], ["q", "Квартал", 3], ["h", "Полгода", 6], ["y", "Год", 12]];
  const same = (r1, r2) => isoDay(r1.from) === isoDay(r2.from) && isoDay(r1.to) === isoDay(r2.to);
  const label = `${range.from.toLocaleDateString("ru-RU")} – ${range.to.toLocaleDateString("ru-RU")}`;
  const el = document.createElement("div"); el.id = "modal"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Детали поступлений");
  el.innerHTML = h`<div class="modal-panel">
    <div class="modal-head"><div><h2>Поступления на счёт</h2><div class="muted small">Детализация по операциям за выбранный период · демонстрационные операции, сформированы из месячных оборотов; в банке здесь будет выписка по счёту</div></div><button class="btn sm" data-act="modal-close" aria-label="Закрыть">×</button></div>
    ${(() => {
      const monthIdx = receipts.findIndex((v, i) => { const dt = monthOf(i), end = new Date(Math.min(maxD, new Date(dt.getFullYear(), dt.getMonth() + 1, 0))); return isoDay(dt) === isoDay(range.from) && isoDay(end) === isoDay(range.to); });
      const monthLabel = monthIdx >= 0 ? monthName(monthOf(monthIdx), false) : "Месяц";
      return h`<div class="period mt"><div class="ptabs scn">
        <span class="month-wrap"><button class="ptab ${monthIdx >= 0 ? "sel" : ""}" data-act="receipts-monthbtn" aria-haspopup="listbox" aria-expanded="false">${monthLabel} ▾</button>
          <div class="month-pop" hidden role="listbox" aria-label="Выбор месяца">${receipts.map((v, i) => h`<button class="mopt ${i === monthIdx ? "sel" : ""}" data-act="receipts-month" data-i="${i}" role="option"><b>${monthName(monthOf(i), false)}</b><span>${monthOf(i).getFullYear()}</span><small>${rub(v)}</small></button>`)}</div></span>
        ${presets.filter(([k]) => k !== "m").map(([k, t, m]) => h`<button class="ptab ${same(range, preset(m)) ? "sel" : ""}" data-act="receipts-preset" data-m="${m}">${t}</button>`)}</div>
      <div class="period-dates"><label>с <input type="date" data-act="receipts-from" value="${isoDay(range.from)}" min="${isoDay(minD)}" max="${isoDay(range.to)}"></label><label>по <input type="date" data-act="receipts-to" value="${isoDay(range.to)}" min="${isoDay(range.from)}" max="${isoDay(maxD)}"></label></div></div>`;
    })()}
    <div class="row between wrapx mt"><div><div class="muted small">${label} · ${days} ${plural(days, "день", "дня", "дней")}</div><div class="big num">${rub(total)}</div></div><span class="chip">${ops.length} ${plural(ops.length, "операция", "операции", "операций")}</span></div>
    <div class="scroll mt ops-scroll"><table class="t ops"><thead><tr><th>Дата</th><th>Плательщик</th><th>Назначение</th><th class="right">Сумма</th></tr></thead><tbody>
      ${ops.length ? ops.map((o) => h`<tr><td class="muted">${dateOnly(o.date)}</td><td><b>${o.payer}</b></td><td class="muted">${o.purpose}</td><td class="right num"><b>+${rub(o.amount)}</b></td></tr>`) : h`<tr><td colspan="4" class="muted">За выбранный период поступлений нет.</td></tr>`}
    </tbody></table></div>
    <p class="hint">Реальная детализация придёт из выписки по счёту; в прототипе операции синтетические и повторяемые. Выгрузка за период — в следующей версии.</p></div>`.s;
  document.body.appendChild(el); document.body.classList.add("iss-open");
  const close = () => { el.classList.add("out"); document.body.classList.remove("iss-open"); setTimeout(() => el.remove(), 400); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  el.addEventListener("click", (e) => {
    if (e.target.closest("[data-act=modal-close]") || e.target === el) { close(); return; }
    const mb = e.target.closest("[data-act=receipts-monthbtn]"); if (mb) { const pop = el.querySelector(".month-pop"); pop.hidden = !pop.hidden; mb.setAttribute("aria-expanded", String(!pop.hidden)); return; }
    if (!e.target.closest(".month-wrap")) { const pop = el.querySelector(".month-pop"); if (pop && !pop.hidden) pop.hidden = true; }
    const m = e.target.closest("[data-act=receipts-month]"); if (m) { showReceipts(receipts, +m.dataset.i); return; }
    const p = e.target.closest("[data-act=receipts-preset]"); if (p) showReceipts(receipts, 11, preset(+p.dataset.m));
  });
  el.addEventListener("change", (e) => {
    const t = e.target; if (!t.dataset.act?.startsWith("receipts-")) return;
    const r = { ...receiptsRange }; const v = t.value ? new Date(t.value + "T00:00:00") : null; if (!v) return;
    if (t.dataset.act === "receipts-from") r.from = v > r.to ? r.to : v; else r.to = v < r.from ? r.from : v;
    showReceipts(receipts, 11, r);
  });
  document.addEventListener("keydown", onKey);
}

function loanBlock(l, acc) {
  const np = l.next_payment;
  return h`<div class="loan"><div class="keyline mb">
      <div><span class="muted small">${T("остаток долга", "Остаток долга")}</span><div class="big num">${rub(l.outstanding)}</div><span class="muted small">из ${rub(l.amount)}</span></div>
      <div><span class="muted small">${l.repaid ? "Статус" : "Ближайший платёж"}</span><div class="big num">${l.repaid ? "Погашен" : rub(np.amount)}</div><span class="muted small">${l.repaid ? "все платежи внесены" : "до " + dateOnly(np.date) + " · №" + np.n + " из " + l.total_count}</span></div>
      <div><span class="muted small">Погашено</span><div class="big">${Math.round(l.progress * 100)} %</div><span class="muted small">платежей: ${l.paid_count} из ${l.total_count}</span></div></div>
    <div class="progress" role="progressbar" aria-valuenow="${Math.round(l.progress * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.max(l.progress * 100, 1)}%"></span></div>
    <div class="row wrapx between small mt"><span class="muted">Выплачено ${T("проценты", "процентов")}: ${rub(l.interest_paid)} из ${rub(l.total_interest)} · всего внесено: ${rub(l.total_paid)}</span>
      ${l.repaid ? "" : h`<button class="btn primary" data-act="pay" data-app="${l.app_id}">Оплатить платёж №${np.n} — ${rub(np.amount)}</button>`}</div>
    <p class="hint">Платёж списывается с расчётного счёта (операция моделируется, реальных списаний нет). Остаток на счёте: <b class="num">${rub(acc.balance)}</b>.</p></div>`;
}

function accountCard(acc) {
  return h`<div class="card flat"><div class="row between wrapx"><div><h3>Расчётный счёт</h3><div class="muted small num">${acc.number}</div></div>
      <div class="right"><span class="muted small">Баланс (демо)</span><div class="big num">${rub(acc.balance)}</div></div></div>
    <div class="row wrapx mt"><input id="topup" type="number" min="1000" max="5000000" step="1000" value="100000" aria-label="Сумма пополнения, ₽" style="max-width:180px">
      <button class="btn" data-act="topup">Пополнить счёт (демо)</button></div>
    <p class="hint">Демо-пополнение: реальных операций нет. С этого счёта оплачиваются платежи по кредиту.</p></div>`;
}

// ---------- клиент: лента «Для вас» (напоминания, предложения, события) ----------
const BELL = raw('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" role="img"><path d="M3.404 9.171L15.233 21l.926-.669.188-1.065a7 7 0 011.943-3.73l1.292-1.293a6.2 6.2 0 001.822-4.416c0-3.53-3.312-6.827-6.827-6.827a6.2 6.2 0 00-4.416 1.822L8.868 6.114a7 7 0 01-3.73 1.943l-1.064.188-.67.926zm2.663 9.078a2.498 2.498 0 003.534 0l-3.534-3.533a2.498 2.498 0 000 3.533z"/></svg>');
const todayKey = () => new Date().toISOString().slice(0, 10);
const feedHidden = (key) => { try { return localStorage.getItem("feed:" + key) === todayKey(); } catch { return false; } };
const daysUntil = (iso) => { const d = new Date(iso); d.setHours(0, 0, 0, 0); const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((d - t) / 864e5); };
const whenText = (n) => n < 0 ? `просрочен на ${-n} ${plural(-n, "день", "дня", "дней")}` : n === 0 ? "сегодня" : n === 1 ? "завтра" : `через ${n} ${plural(n, "день", "дня", "дней")}`;
const plural = (n, a, b, c) => { const m = n % 10, k = n % 100; return (k >= 11 && k <= 14) ? c : m === 1 ? a : (m >= 2 && m <= 4) ? b : c; };

function feedCards(prof, prod, active) {
  const cards = [];
  // 1. Ближайший платёж по каждому действующему кредиту — главная карточка ленты
  for (const l of prof.loans) {
    if (l.repaid || !l.next_payment) continue;
    const np = l.next_payment, key = `pay-${l.app_id}-${np.n}`;
    if (feedHidden(key)) continue;
    const n = daysUntil(np.date), lack = Math.max(0, np.amount - prof.account.balance);
    const mood = n < 0 ? "late" : n <= 3 ? "soon" : "";
    cards.push(h`<article class="fcard pay ${mood}" data-key="${key}" style="--i:${cards.length}">
      <span class="fico" aria-hidden="true">${BELL}</span>
      <button class="fx" data-act="feed-dismiss" data-key="${key}" aria-label="Скрыть до завтра">×</button>
      <div class="fbody"><small class="fcat">${n < 0 ? "Просрочка" : "Платёж по кредиту"}</small><div class="ftitle">${n < 0 ? "Платёж просрочен" : "Платёж"} ${rub(np.amount)} <span class="fwhen">· ${n < 0 ? whenText(n) : "до " + dateOnly(np.date) + ", " + whenText(n)}</span></div>
      <p class="ftext">${l.product_title} · платёж №${np.n} из ${l.total_count} · спишем с расчётного счёта.
        ${lack > 0 ? h`<b class="flack">На счёте ${rub(prof.account.balance)}, не хватает ${rub(lack)} — пополните счёт.</b>` : h`На счёте ${rub(prof.account.balance)} — хватает.`}</p>
      <div class="facts"><button class="btn primary" data-act="pay" data-app="${l.app_id}" ${lack > 0 ? "disabled" : ""}>Оплатить сейчас</button>
        <button class="btn link" data-act="feed-dismiss" data-key="${key}">Напомнить завтра</button></div></div></article>`);
  }
  // 2. Нужно действие клиента по активной заявке
  if (active && active.status.turn === "client" && !feedHidden("act-" + active.id + "-" + active.status.code)) {
    const key = "act-" + active.id + "-" + active.status.code;
    cards.push(h`<article class="fcard need" data-key="${key}" style="--i:${cards.length}">
      <button class="fx" data-act="feed-dismiss" data-key="${key}" aria-label="Скрыть до завтра">×</button>
      <div class="fbody"><small class="fcat">Заявка</small><div class="ftitle">Нужно ваше действие</div><p class="ftext">${active.status.title}: ${active.status.text}</p>
      <div class="facts"><a class="btn primary" href="#/client/app/${active.id}">Открыть заявку</a></div></div></article>`);
  }
  // 3. Лучшее предодобренное предложение — всегда (двигаем продукт); при активной заявке ведёт в раздел продуктов, т.к. вторая заявка не открывается
  {
    const best = prof.preapproval.filter((p) => p.available && prod[p.product]?.eligible).sort((a, b) => b.max_amount - a.max_amount)[0];
    const key = best && `pre-${best.product}-${best.max_amount}`;
    if (best && !feedHidden(key)) cards.push(h`<article class="fcard" data-key="${key}" style="--i:${cards.length}">
      <img class="fico img" src="img/products/${best.product}.webp" alt="" width="512" height="512" loading="lazy" decoding="async">
      <button class="fx" data-act="feed-dismiss" data-key="${key}" aria-label="Скрыть до завтра">×</button>
      <div class="fbody"><small class="fcat">Предодобрено</small><div class="ftitle">Предодобрено до ${rub(best.max_amount)}</div>
      <p class="ftext">${prod[best.product].title} · ставка от ${pct(best.rate_from)} · по оборотам, которые банк уже видит.${active ? " Доступно после завершения текущей заявки." : " Без справок и визита."}</p>
      <div class="facts">${active ? h`<a class="btn primary" href="#/client/products">Смотреть продукты</a>` : h`<button class="btn primary" data-act="new-app" data-product="${best.product}">Оформить</button>`}</div></div></article>`);
    const pref = prof.preapproval.find((p) => p.product === "preferential" && p.available && prod.preferential?.eligible);
    if (pref && best?.product !== "preferential" && !feedHidden("pref")) cards.push(h`<article class="fcard ok" data-key="pref" style="--i:${cards.length}">
      <button class="fx" data-act="feed-dismiss" data-key="pref" aria-label="Скрыть до завтра">×</button>
      <div class="fbody"><small class="fcat">Господдержка</small><div class="ftitle">Вам доступна льготная программа</div>
      <p class="ftext">Компания в реестре МСП приоритетной отрасли: ставка от ${pct(pref.rate_from)} до ${rub(pref.max_amount)}.</p>
      <div class="facts">${active ? h`<a class="btn" href="#/client/products">Посмотреть условия</a>` : h`<button class="btn" data-act="new-app" data-product="preferential">Посмотреть условия</button>`}</div></div></article>`);
  }
  return cards;
}
function feedBlock(prof, prod, active) {
  const cards = feedCards(prof, prod, active);
  return cards.length ? h`<section class="feed" aria-label="Для вас"><div class="feed-track">${cards}</div></section>` : "";
}
// единая лента «Для вас»: напоминания и предложения + новости и сервисы банка, автопрокрутка маятником
const FEED_MAX = 4, FEED_OWN_MAX = 2;   // четыре плитки: 2 свои (напоминание о платеже и предодобренное — всегда в приоритете) + 2 материала/продукта
function industryOf(okved) {
  const code = parseInt(String(okved || "").slice(0, 2), 10);
  if (code === 62 || code === 63) return "it"; if (code === 56) return "catering"; if (code >= 41 && code <= 43) return "construction";
  if (code >= 45 && code <= 47) return "trade"; if (code >= 49 && code <= 53) return "transport"; if (code >= 10 && code <= 33) return "production"; return "other";
}
function businessContext(prof, c) {
  const tags = new Set(["any", industryOf(prof.company?.okved)]);
  if (prof.tenure_months < 12) tags.add("young");
  if (prof.loans.some((l) => !l.repaid)) tags.add("loan");
  if (prof.msp) tags.add("msp");
  if (c?.forecast?.base?.gap || c?.forecast?.gap) tags.add("gap");
  if (tags.has("trade")) tags.add("retail");
  return tags;
}
function pickNews(tags, n) {
  const scored = BANK_NEWS.map((x, i) => ({ x, i, score: (x.tags || []).reduce((acc, t) => acc + (t === "any" ? 0.5 : tags.has(t) ? 3 : 0), 0) }));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const out = [], cats = {};
  for (const sItem of scored) { if (out.length >= n) break; if ((cats[sItem.x.cat] || 0) >= 2) continue; cats[sItem.x.cat] = (cats[sItem.x.cat] || 0) + 1; out.push(sItem.x); }
  return out;
}
function forYouBlock(prof, prod, active) {
  const all = feedCards(prof, prod, active);
  // приоритет своих карточек: платёж → предодобрено → действие по заявке → льготная; берём первые две
  const rank = (cd) => { const k = /data-key="([a-z]+)/.exec(cd.s)?.[1]; return { pay: 0, pre: 1, act: 2, pref: 3 }[k] ?? 9; };
  const own = all.map((cd, i) => [cd, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([cd]) => cd).slice(0, FEED_OWN_MAX);
  const tags = businessContext(prof, window.__client);
  const picked = pickNews(tags, Math.max(0, FEED_MAX - own.length));
  // цвет каждой плитки по позиции: срочный платёж всегда красный, остальные — свободные цвета без повторов и без соседей одного цвета
  const tones = assignTones([...own.map((cd) => (/class="fcard pay (?:soon|late)/.test(cd.s) ? "red" : null)), ...picked.map(() => null)]);
  const cards = own.map((cd, i) => raw(cd.s.replace('class="fcard', `class="fcard t-${tones[i]}`)));
  const news = picked.map((n, i) => h`<a class="ncard ${tones[i + cards.length]}" href="${n.href}" target="_blank" rel="noopener" style="--i:${Math.min(i + cards.length, 6)}"><small>${n.cat}${n.ext ? " · вне банка" : ""}</small><b>${n.title}</b><span>${n.text}</span><i class="go">Открыть →</i></a>`);
  const why = [...tags].filter((t) => t !== "any" && t !== "retail").map((t) => ({ it: "ИТ", catering: "общепит", construction: "строительство", trade: "торговля", transport: "транспорт", production: "производство", other: "ваша отрасль", young: "молодой бизнес", loan: "действующий кредит", msp: "реестр МСП", gap: "риск кассового разрыва" }[t])).join(", ");
  return h`<section class="feed foryou mb" aria-label="Для вас"><div class="row between wrapx feed-head"><div><h2 style="margin:0">Для вас</h2><span class="muted small">подобрано по профилю: ${why} · ${cards.length + news.length} из ${FEED_MAX}</span></div>
      <div class="news-nav"><button class="btn sm" data-act="news-prev" aria-label="Назад">←</button><button class="btn sm" data-act="news-next" aria-label="Вперёд">→</button></div></div>
    <div class="feed-track" data-news data-auto>${cards}${news}</div></section>`;
}
// плавный шаг карусели: ~0.8 с с замедлением на концах (нативный smooth вдвое резче); snap отключён на время анимации
function glide(t, dx, ms = 800) {
  const from = t.scrollLeft, maxX = t.scrollWidth - t.clientWidth, to = Math.max(0, Math.min(maxX, from + dx)), t0 = performance.now();
  if (t._glide) cancelAnimationFrame(t._glide);
  const snap = t.style.scrollSnapType; t.style.scrollSnapType = "none";
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const frame = (now) => {
    const k = Math.min(1, (now - t0) / ms); t.scrollLeft = from + (to - from) * ease(k);
    if (k < 1) t._glide = requestAnimationFrame(frame); else { t._glide = 0; t.style.scrollSnapType = snap; }
  };
  t._glide = requestAnimationFrame(frame);
}

// цвета плиток ленты чередуются по позиции (палитра alfabank.ru), соседние никогда не совпадают
const TONE_CYCLE = ["violet", "paper", "red", "lime"];
const toneAt = (i) => TONE_CYCLE[((i % TONE_CYCLE.length) + TONE_CYCLE.length) % TONE_CYCLE.length];
// fixed[i] — заданный цвет (или null): свободным позициям даём первый цвет, который ещё не использован и не совпадает с соседом слева
function assignTones(fixed) {
  const out = [], used = new Set();
  fixed.forEach((f, i) => {
    const prev = out[i - 1];
    let t = f && f !== prev ? f : null;
    if (!t) t = TONE_CYCLE.find((c) => !used.has(c) && c !== prev) || TONE_CYCLE.find((c) => c !== prev) || TONE_CYCLE[0];
    used.add(t); out.push(t);
  });
  return out;
}

function initCarousels() {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  $$("[data-auto]:not([data-live])").forEach((t) => {
    t.dataset.live = "1"; let dir = 1, pausedUntil = performance.now() + 3000, hover = false;
    const pause = (ms = 7000) => { pausedUntil = performance.now() + ms; };
    t.addEventListener("mouseenter", () => { hover = true; }); t.addEventListener("mouseleave", () => { hover = false; });
    t.addEventListener("focusin", () => { hover = true; }); t.addEventListener("focusout", () => { hover = false; });
    ["pointerdown", "touchstart", "wheel"].forEach((e) => t.addEventListener(e, () => pause(), { passive: true }));
    t.closest(".feed")?.querySelectorAll("[data-act=news-prev],[data-act=news-next]").forEach((bt) => bt.addEventListener("click", () => pause(9000)));
    const stepPx = () => { const c0 = t.children[0], c1 = t.children[1]; return c1 ? c1.offsetLeft - c0.offsetLeft : (c0?.offsetWidth || 300) + 12; };
    const tick = () => {
      if (!t.isConnected) { clearInterval(t._timer); return; }
      const maxX = t.scrollWidth - t.clientWidth;
      if (maxX < 4 || hover || performance.now() < pausedUntil || document.hidden) return;
      if (dir > 0 && t.scrollLeft >= maxX - 2) dir = -1; else if (dir < 0 && t.scrollLeft <= 2) dir = 1;
      glide(t, dir * stepPx());                                              // шаг на одну карточку, плавно
    };
    t._timer = setInterval(tick, 3500);
  });
}

// ---------- клиент: главная с разделами (Обзор · Кредиты · Новый кредит · Поступления) ----------
const CLIENT_TABS = [["overview", "Обзор"], ["loans", "Кредиты"], ["products", "Новый кредит"], ["receipts", "Поступления"]];
let clientTab = "overview";

function clientSection(k, c) {
  const { prof, apps, prod, active } = c, cn = prof.company;
  const appsCard = h`<div class="card"><h2>Мои заявки</h2>
    ${apps.length ? apps.map((a) => h`<a href="#/client/app/${a.id}" class="approw">
      <span><b>${a.product_title}</b><br><span class="muted small">${a.id} · ${rub(a.amount)} · ${a.term} мес. · ${dateOnly(a.created)}</span></span>
      ${chip(a.status.code, a.status.title)}</a>`) : h`<p class="muted">Заявок пока нет. Подберите продукт в разделе «Новый кредит» — это займёт около 3 минут.</p>`}
    <button class="btn primary mt" data-act="new-app" ${active ? "disabled" : ""}>Новая заявка</button>
    ${active ? h`<p class="hint">Новую заявку можно подать после завершения текущей.</p>` : ""}</div>`;
  const activeCard = active ? h`<a class="card status ${active.status.turn} mb" href="#/client/app/${active.id}" style="display:block;color:inherit;text-decoration:none">
      <div class="row between wrapx"><div><span class="muted small">Активная заявка ${active.id} · ${active.product_title} · ${rub(active.amount)} на ${active.term} мес.</span>
      <h2 style="margin-top:4px">${active.status.title}</h2><p class="muted" style="margin:0">${active.status.text}</p></div>
      <span class="btn primary">${active.status.turn === "client" ? "Нужно ваше действие →" : "Открыть →"}</span></div></a>` : "";

  if (k === "loans") {
    const open = prof.loans.filter((l) => !l.repaid), closed = prof.loans.filter((l) => l.repaid);
    if (loanIdx >= open.length) loanIdx = 0;
    const l = open[loanIdx], sched = l && c.det?.[l.app_id]?.schedule;
    return h`${activeCard}
    ${open.length ? h`<div class="row between wrapx mb"><h2 style="margin:0">Мои кредиты</h2>
        ${open.length > 1 ? h`<nav class="ptabs loan-switch" aria-label="Выбор кредита">${open.map((x, i) => h`<button class="ptab ${i === loanIdx ? "sel" : ""}" data-act="loan-pick" data-i="${i}">${x.product_title} <small>${x.contract}</small></button>`)}</nav>` : ""}</div>
      <div class="grid g2 mb"><div class="card"><div class="row between wrapx"><div><b>${l.product_title}</b><br><span class="muted small">Договор ${l.contract} · ${pct(l.rate)}${sched ? " · до " + dateOnly(sched[sched.length - 1].date) : ""}</span></div>
          <a class="small" href="#/client/app/${l.app_id}">График и детали →</a></div>
          ${sched ? balanceSpark(sched, l) : ""}
          <div class="mt">${loanBlock(l, prof.account)}</div>
          ${prepayCalc(l)}</div>${accountCard(prof.account)}</div>`
      : h`<div class="card flat empty mb"><h2>Действующих кредитов нет</h2><p class="muted">Когда кредит будет выдан, здесь появятся остаток долга, график и кнопка оплаты платежа. Подобрать продукт можно в разделе <a href="#/client/products">«Новый кредит»</a>.</p></div>`}
    ${closed.length ? h`<h2>Закрытые кредиты</h2><div class="card mb archive">${closed.map((x) => { const sc = c.det?.[x.app_id]?.schedule; return h`<a class="approw" href="#/client/app/${x.app_id}">
        <span><b>${x.product_title}</b><br><span class="muted small">Договор ${x.contract} · ${rub(x.amount)} · ${pct(x.rate)}${sc ? " · " + dateOnly(sc[0].date) + " – " + dateOnly(sc[sc.length - 1].date) : ""} · проценты ${rub(x.total_interest)}</span></span>
        <span class="chip ok">Погашен</span></a>`; })}</div>` : ""}
    ${appsCard}`;
  }

  if (k === "products") return h`${activeCard}
    <h2>Предодобрено по данным, которые банк уже знает</h2>
    <p class="muted small">Предварительная оценка по вашим оборотам — не гарантия: итоговые условия назовёт банк после проверки заявки.</p>
    <div class="grid g4 mb">${prof.preapproval.map((p) => {
      const pr = prod[p.product];
      const head = h`<img class="pimg" src="img/products/${p.product}.webp" alt="" width="512" height="512" loading="lazy" decoding="async"><h3>${pr.title}</h3>`;
      if (!pr.eligible) return h`<div class="card flat pcard">${head}<p class="muted small">Программа для МСП приоритетных отраслей — для вашей компании недоступна.</p></div>`;
      return h`<div class="card flat pcard">${head}
        ${p.available ? h`<div class="big num" data-count="${p.max_amount}" data-prefix="до ">до ${rub(p.max_amount)}</div><div class="muted small">ставка от ${pct(p.rate_from)}</div>
          <button class="btn primary" data-act="new-app" data-product="${p.product}" ${active ? "disabled" : ""}>Оформить</button>`
          : h`<p class="muted small">${p.message}</p><button class="btn" data-act="new-app" data-product="${p.product}" ${active ? "disabled" : ""}>Подать заявку</button>`}</div>`;
    })}</div>
    <div class="card flat"><div class="row between wrapx"><div><h3>Не знаете, какой продукт нужен?</h3><p class="muted small" style="margin:0">Опишите задачу — подскажем продукт, сумму и срок, которые укладываются в платёжеспособность.</p></div>
      <button class="btn violet" data-act="new-app" ${active ? "disabled" : ""}>Подобрать по задаче</button></div></div>`;

  if (k === "receipts") return h`<div class="card"><h2>Поступления на счёт за 12 месяцев</h2>
      ${turnoverChart(prof.receipts)}
      <div class="stat"><span>Среднее: <b class="num">${rub(prof.avg_receipts)}</b> / мес.</span>
      <span>Динамика (6 мес. к предыдущим 6): <b>${prof.dynamics >= 0 ? "+" : ""}${Math.round(prof.dynamics * 100)} %</b></span>
      <span>Платежи по кредитам: <b class="num">${rub(prof.existing_payments)}</b></span></div>
      <p class="hint">Эти же обороты видит скоринг: среднее поступление и его стабильность определяют комфортную сумму кредита.</p></div>`;

  // Обзор: лента, активная заявка, короткие плитки-ссылки в разделы
  const loan = prof.loans.find((l) => !l.repaid && l.next_payment), best = prof.preapproval.filter((p) => p.available).sort((x, y) => y.max_amount - x.max_amount)[0];
  const last = prof.receipts.length - 1, prev = prof.receipts[last - 1] || 0, dl = prev ? Math.round((prof.receipts[last] / prev - 1) * 100) : 0;
  return h`${forYouBlock(prof, prod, active)}${activeCard}
    <div class="grid smart mb">${radarCard(c.forecast, prod)}${limitCard(c.limit, prod)}</div>
    <div class="tiles g4 mb">
      ${loan ? h`<a class="tile" href="#/client/loans"><span>Ближайший платёж</span><b data-count="${loan.next_payment.amount}">${rub(loan.next_payment.amount)}</b><span>до ${dateOnly(loan.next_payment.date)} · остаток ${rub(loan.outstanding)}</span></a>`
             : h`<a class="tile" href="#/client/loans"><span>Кредиты</span><b>${apps.length ? apps.length : "—"}</b><span>${apps.length ? plural(apps.length, "заявка", "заявки", "заявок") + " в истории" : "действующих кредитов нет"}</span></a>`}
      <a class="tile violet" href="#/client/products"><span>Предодобрено</span><b data-count="${best?.max_amount ?? 0}" data-prefix="до ">${best ? "до " + rub(best.max_amount) : "—"}</b><span>${best ? prod[best.product].title + " · от " + pct(best.rate_from) : "подайте заявку — рассмотрим вручную"}</span></a>
      <a class="tile" href="#/client/receipts"><span>Поступления, ${monthName(monthOf(last), false)}</span><b data-count="${prof.receipts[last]}">${rub(prof.receipts[last])}</b><span>${dl >= 0 ? "+" : ""}${dl} % к прошлому месяцу · среднее ${rub(prof.avg_receipts)}</span></a>
      <a class="tile" href="#/client/receipts"><span>Платёжная нагрузка</span><b>${prof.avg_receipts ? Math.round(prof.existing_payments / prof.avg_receipts * 100) : 0} %</b><span>платежи по кредитам ${rub(prof.existing_payments)} от среднего поступления</span></a>
    </div>
    ${apps.length && !active ? h`<div class="card flat"><div class="row between wrapx"><div><b>Последняя заявка</b><br><span class="muted small">${apps[0].product_title} · ${rub(apps[0].amount)} · ${dateOnly(apps[0].created)}</span></div>${chip(apps[0].status.code, apps[0].status.title)}</div></div>` : ""}`;
}

let loanIdx = 0;

// ---------- лента новостей и сервисов банка (требование кейса: «новостная лента под клиента») ----------
const BANK_NEWS = [
  { cat: "Новости", href: "https://alfabank.ru/corporate/news/", title: "Новости масштабного бизнеса", text: "Аналитика рынка и новости для вашего бизнеса первыми", tone: "blue", tags: ["any"] },
  { cat: "Сервис", href: "https://alfabank.ru/sme/abp/services/market_puls/", title: "Пульс рынка", text: "Сравните себя с конкурентами по данным эквайринга", tone: "mint", tags: ["trade", "catering", "retail"] },
  { cat: "Кредиты", href: "https://alfabank.ru/sme/profits/credit-holidays-mob/", title: "Кредитные каникулы", text: "Отсрочка платежей, если бизнесу нужна передышка", tone: "graphite", tags: ["loan"] },
  { cat: "Кредиты", href: "https://alfabank.ru/sme/profits/goscredit/", title: "Кредит с господдержкой", text: "Льготные ставки по программам субсидирования", tone: "red", tags: ["production", "it", "msp"] },
  { cat: "Кредиты", href: "https://alfabank.ru/sme/profits/sub/", title: "Подписки на кредитные продукты", text: "Скидка на ставку по овердрафту и кредитной линии", tone: "violet", tags: ["loan", "gap"] },
  { cat: "Кредиты", href: "https://alfabank.ru/sme/profits/business_insurance/", title: "Защита бизнеса", text: "Скидка на кредит 4,5 % и защита от непредвиденных расходов", tone: "graphite", tags: ["loan", "production", "transport"] },
  { cat: "Кредиты", href: "https://alfabank.ru/sme/profits/alfastart/", title: "Альфа-Старт", text: "Финансирование для начинающего бизнеса", tone: "mint", tags: ["young"] },
  { cat: "Финансирование", href: "https://alfabank.ru/sme/guarantee/client/", title: "Банковская гарантия", text: "Для контрактов и госзакупок без замораживания денег", tone: "blue", tags: ["construction", "it", "tenders"] },
  { cat: "Финансирование", href: "https://alfabank.ru/sme/profits/factoring/", title: "Факторинг", text: "Деньги за поставки сразу, не дожидаясь оплаты покупателя", tone: "red", tags: ["trade", "production"] },
  { cat: "Финансирование", href: "https://alfaleasing.ru/", title: "Лизинг", text: "Техника и транспорт в лизинг от Альфа-Лизинга", tone: "graphite", tags: ["transport", "production", "construction"] },
  { cat: "Сервис", href: "https://alfabank.ru/sme/abp/services/check-contragent/", title: "Проверка контрагентов", text: "Риски партнёра до подписания договора", tone: "violet", tags: ["trade", "construction", "young"] },
  { cat: "Сервис", href: "https://alfabank.ru/sme/abp/bookkeeping/", title: "Альфа-Бухгалтерия", text: "Налоги и отчётность для ИП и ООО внутри банка", tone: "mint", tags: ["young", "it", "catering"] },
  { cat: "Сервис", href: "https://alfabank.ru/sme/alfaapi/", title: "Alfa API", text: "Интеграция банка с вашей ERP и учётом", tone: "blue", tags: ["it", "trade"] },
  { cat: "Полезное", href: "https://alfabank.ru/sme/115fz/how-to-protect/", title: "Полезное о 115-ФЗ", text: "Как не попасть под блокировку счёта", tone: "red", tags: ["young", "trade"] },
  { cat: "Сообщество", href: "https://alfabank.ru/sme/fond/", title: "Фонд немалого бизнеса", text: "Расскажите про бизнес и получите деньги на рекламу", tone: "graphite", tags: ["catering", "trade", "young"] },
  { cat: "Сообщество", href: "https://alfabank.ru/sme/confa/", title: "Альфа-Конфа", text: "Масштабные события для бизнеса и предпринимателей", tone: "violet", tags: ["any"] },
  { cat: "Обучение", href: "https://kurs.alfabank.ru/", title: "Бизнес-школа Альфа-Курс", text: "Курсы для предпринимателей от практиков", tone: "mint", tags: ["young"] },
  { cat: "Обучение", href: "https://alfabank.ru/help/articles/sme/", title: "Полезные статьи для бизнеса", text: "Разборы, инструкции и кейсы для малого бизнеса", tone: "blue", tags: ["any"] },
  { cat: "Сервис", href: "https://alfabank.ru/corporate/lab-robot/", title: "Лаборатория роботизации", text: "Считаем окупаемость, подбираем технологию и финансируем внедрение", tone: "graphite", tags: ["production"] },
  { cat: "Направления", href: "https://alfabank.ru/corporate/china/", title: "Бизнес с Китаем", text: "Расчёты, закупки и сопровождение компаний, работающих с КНР", tone: "red", tags: ["trade", "production"] },
  // полезное для предпринимателей вне банка: господдержка, реестры, торги, регуляторика
  { cat: "Господдержка", href: "https://мойбизнес.рф", title: "Мой бизнес", text: "Центры поддержки предпринимателей в регионах: консультации, обучение, льготы", tone: "mint", ext: true, tags: ["young", "msp"] },
  { cat: "Господдержка", href: "https://мсп.рф", title: "Цифровая платформа МСП.РФ", text: "Меры поддержки, льготное кредитование, сервисы для малого бизнеса", tone: "violet", ext: true, tags: ["msp", "young"] },
  { cat: "Господдержка", href: "https://corpmsp.ru", title: "Корпорация МСП", text: "Зонтичные поручительства и гарантии по кредитам для МСП", tone: "blue", ext: true, tags: ["msp", "production"] },
  { cat: "Реестры", href: "https://rmsp.nalog.ru", title: "Единый реестр МСП", text: "Проверьте, что компания в реестре — это условие льготных программ", tone: "graphite", ext: true, tags: ["msp"] },
  { cat: "Реестры", href: "https://pb.nalog.ru", title: "ФНС «Прозрачный бизнес»", text: "Проверка себя и контрагентов: задолженность, адрес, руководитель", tone: "red", ext: true, tags: ["trade", "construction"] },
  { cat: "Торги", href: "https://zakupki.gov.ru", title: "Госзакупки (ЕИС)", text: "Тендеры и контракты — под них банк даёт гарантии и кредит под контракт", tone: "blue", ext: true, tags: ["construction", "it", "tenders"] },
  { cat: "Регуляторика", href: "https://cbr.ru/hd_base/KeyRate/", title: "Ключевая ставка Банка России", text: "От неё считается ваша ставка по кредиту", tone: "graphite", ext: true, tags: ["loan", "any"] },
  { cat: "Регуляторика", href: "https://честныйзнак.рф", title: "Честный знак", text: "Обязательная маркировка товаров: сроки и категории", tone: "mint", ext: true, tags: ["trade", "production"] },
  { cat: "Сервисы", href: "https://www.gosuslugi.ru", title: "Госуслуги для бизнеса", text: "Лицензии, разрешения, выписки и уведомления в одном окне", tone: "violet", ext: true, tags: ["young"] },
  { cat: "Платежи", href: "https://sbp.nspk.ru/business/", title: "СБП для бизнеса", text: "Приём оплаты по QR с низкой комиссией", tone: "red", ext: true, tags: ["catering", "trade", "retail"] },
];
function newsBlock() {
  return h`<section class="news mb" aria-label="Новости и сервисы банка"><div class="row between wrapx"><div><h2 style="margin:0">Новости и сервисы банка</h2><span class="muted small">alfabank.ru и полезные ресурсы для бизнеса · ${BANK_NEWS.length} ссылок</span></div>
      <div class="news-nav"><button class="btn sm" data-act="news-prev" aria-label="Назад">←</button><button class="btn sm" data-act="news-next" aria-label="Вперёд">→</button></div></div>
    <div class="news-track" data-news>${BANK_NEWS.map((n, i) => h`<a class="ncard ${toneAt(i)}" href="${n.href}" target="_blank" rel="noopener" style="--i:${Math.min(i, 5)}"><small>${n.cat}${n.ext ? " · вне банка" : ""}</small><b>${n.title}</b><span>${n.text}</span><i class="go">Открыть →</i></a>`)}</div></section>`;
}


// ---------- «Финансовый радар»: факт 12 мес. + прогноз 3 мес. + траектория остатка на 90 дней ----------
const RADAR_RANGES = { q: [3, "Квартал"], h: [6, "Полгода"], y: [12, "Год"] };
let radarRange = (() => { try { return RADAR_RANGES[localStorage.getItem("radar-range")] ? localStorage.getItem("radar-range") : "q"; } catch { return "q"; } })();
function radarChart(f) {
  const factN = RADAR_RANGES[radarRange][0], off = 12 - factN, fact = f.fact.slice(off);
  const W = 600, H = 120, n = factN + 3, gap = factN > 6 ? 10 : 14, bw = (W - (n - 1) * gap) / n;
  const vals = [...fact, ...f.months.map((m) => m.receipts)];
  const max = Math.max(...vals) * 1.08;
  const y = (v) => H - Math.max(0, v) / max * H, x = (i) => i * (bw + gap);
  const fx0 = x(factN), fw = 3 * (bw + gap) - gap;
  const avg = f.fact.reduce((a2, b2) => a2 + b2, 0) / f.fact.length;
  return h`<svg class="chart rchart" viewBox="0 0 ${W} ${H + 22}" role="img" aria-label="Поступления за 12 месяцев и прогноз на 3 месяца"><defs><linearGradient id="vgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9a85ff"/><stop offset="1" stop-color="#5a3df0"/></linearGradient><linearGradient id="ggrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c6ff4d"/><stop offset="1" stop-color="#8fd400"/></linearGradient><linearGradient id="rgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff6b5e"/><stop offset="1" stop-color="#d61f12"/></linearGradient></defs>
    <rect class="r-fzone" x="${fx0 - gap / 2}" y="0" width="${fw + gap}" height="${H}" rx="8"/>
    <line class="r-avg" x1="0" x2="${W}" y1="${y(avg)}" y2="${y(avg)}"/>
    ${vals.map((v, i) => h`<g style="--i:${i}"><rect class="bar ${i >= factN ? "fc" : i === factN - 1 ? "now" : (i + off > 0 && v < f.fact[i + off - 1] * 0.8) ? "drop" : v < avg ? "low" : ""}" x="${x(i)}" y="${y(v)}" width="${bw.toFixed(1)}" height="${(H - y(v)).toFixed(1)}" rx="5"/>
      ${i >= factN && f.months[i - factN].high ? h`<line class="r-band" x1="${x(i) + bw / 2}" x2="${x(i) + bw / 2}" y1="${y(f.months[i - factN].high)}" y2="${y(f.months[i - factN].low)}"/>` : ""}
      <text x="${x(i) + bw / 2}" y="${H + 15}" text-anchor="middle">${i < factN ? monthName(monthOf(i + off), false) : monthName(new Date(f.months[i - factN].month + "-01"), false) + "*"}</text></g>`)}
  </svg>`;
}
// остаток на счёте на 90 дней — отдельный широкий график: плавная область, подушка, платежи, даты
function balanceChart(f, fs) {
  const W = 600, H = 110, padL = 2, padR = 2;
  const all = fs ? [fs.base, fs.opt, fs.pes] : [f];
  const allBal = all.flatMap((q) => q.path.map((p) => p.balance));
  const vmin = Math.min(0, ...allBal, f.cushion), vmax = Math.max(...allBal, f.balance, f.cushion) * 1.06 || 1;
  const yb = (v) => 6 + (H - 12) * (1 - (v - vmin) / (vmax - vmin)), px = (day) => padL + (day / f.horizon_days) * (W - padL - padR);
  const smooth = (q) => { const pts = [[px(0), yb(q.balance)], ...q.path.map((p, i) => [px(i + 1), yb(p.balance)])];
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; d += ` Q${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`; }
    return { pts, d: d + ` L${pts[pts.length - 1][0].toFixed(1)} ${pts[pts.length - 1][1].toFixed(1)}` }; };
  const { pts, d } = smooth(f);
  const others = fs ? all.filter((q) => q !== f).map((q) => smooth(q).d) : [];
  const area = d + ` L${px(f.horizon_days)} ${H} L${px(0)} ${H} Z`;
  const gapPt = f.gap ? pts[f.gap.day] : null, fmt = (v) => (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1).replace(".", ",") + " млн" : Math.round(v / 1e3) + " тыс.");
  const ticks = [0, 30, 60, 90].map((dd) => [dd, new Date(new Date(f.today).getTime() + dd * 864e5)]);
  return h`<svg class="bchart" viewBox="0 0 ${W} ${H + 22}" role="img" aria-label="Остаток на счёте на 90 дней вперёд">
    <defs><linearGradient id="bgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--chart-b)" stop-opacity=".45"/><stop offset="1" stop-color="var(--chart-b)" stop-opacity="0"/></linearGradient></defs>
    ${vmin < 0 ? h`<rect class="b-neg" x="${px(0)}" y="${yb(0)}" width="${W - padL - padR}" height="${(H - yb(0)).toFixed(1)}"/>` : ""}
    <path class="b-area" d="${area}"/>${others.map((od) => h`<path class="b-other" d="${od}"/>`)}<path class="b-line" d="${d}"/>
    <line class="r-cushion" x1="${px(0)}" x2="${px(f.horizon_days)}" y1="${yb(f.cushion)}" y2="${yb(f.cushion)}"/>
    <text class="b-lbl" x="${px(f.horizon_days)}" y="${yb(f.cushion) - 4}" text-anchor="end">подушка ${fmt(f.cushion)}</text>
    ${vmin < 0 ? h`<line class="r-zero" x1="${px(0)}" x2="${px(f.horizon_days)}" y1="${yb(0)}" y2="${yb(0)}"/>` : ""}
    ${f.payments.filter((p) => p.kind === "loan").map((p) => h`<g class="b-pay"><line x1="${px(dayIndex(f.today, p.date))}" x2="${px(dayIndex(f.today, p.date))}" y1="${H - 8}" y2="${H}"/><title>${dateOnly(p.date)} · платёж по кредиту ${rub(p.amount)}</title></g>`)}
    ${gapPt ? h`<circle class="r-gap" cx="${gapPt[0]}" cy="${gapPt[1]}" r="5"><title>${dateOnly(f.gap.date)} · остаток ниже подушки</title></circle>` : ""}
    <circle class="b-now" cx="${pts[0][0]}" cy="${pts[0][1]}" r="4"/>
    ${ticks.map(([dd, dt]) => h`<text x="${px(dd)}" y="${H + 16}" text-anchor="${dd === 0 ? "start" : dd === 90 ? "end" : "middle"}">${dd === 0 ? "сегодня" : dt.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</text>`)}
  </svg>`;
}
// профицит: радар советует, а не продаёт — разместить свободные деньги, погасить досрочно, держать резерв
function surplusAdvice(f, fs, prod) {
  const loans = (window.__client?.prof.loans || []).filter((l) => !l.repaid && l.next_payment);
  const free = f.free_cash, tips = [];
  const pes = fs?.pes, risk = pes && pes !== f && pes.gap ? pes : null;
  if (risk) tips.push({ k: "reserve", t: `Держите резерв ${rub(risk.gap.amount)}`, d: `В пессимистичном сценарии (поступления −${Math.round(fs.delta * 100)} %) разрыв возможен через ${risk.gap.day} ${plural(risk.gap.day, "день", "дня", "дней")}. Резерв на счёте или заранее подключённый овердрафт без использования закроют его бесплатно.`, href: risk.offer ? `#/client/new?product=${risk.offer.product}&amount=${risk.offer.amount}&term=${risk.offer.term}&purpose=gap` : "#/client/products", btn: risk.offer ? "Подключить овердрафт про запас" : "Подобрать защиту" });
  if (free >= 100000) {
    const dep = Math.floor((risk ? Math.max(0, free - risk.gap.amount) : free) * 0.8 / 10000) * 10000;
    if (dep >= 100000) tips.push({ k: "deposit", t: `Разместите до ${rub(dep)} на 1–3 месяца`, d: `Эти деньги не понадобятся в ближайшие 90 дней даже с подушкой. Овернайт или накопительный счёт для бизнеса приносят доход и остаются доступными.`, href: "https://alfabank.ru/sme/deposits/online/", ext: true, btn: "Депозиты для бизнеса", href2: "https://alfabank.ru/sme/rko/nakoplenie/", btn2: "Накопительный счёт" });
  }
  for (const l of loans) {
    const rem = l.total_count - l.paid_count, r = l.rate / 1200, P = l.next_payment.amount, extra = Math.min(l.outstanding - P, Math.floor(free * 0.5 / 10000) * 10000);
    if (extra >= 50000 && rem > 1) {
      const left = l.outstanding - extra, curInt = P * rem - l.outstanding, nNew = left * r < P ? Math.max(1, Math.ceil(-Math.log(1 - left * r / P) / Math.log(1 + r))) : rem, save = Math.max(0, curInt - (P * nNew - left));
      if (save > 0) tips.push({ k: "prepay", t: `Внесите ${rub(extra)} досрочно — экономия ${rub(save)}`, d: `${l.product_title}: срок сократится с ${rem} до ${nNew} мес. при том же платеже ${rub(P)}. Расчёт предварительный, без комиссий.`, href: "#/client/loans", btn: "К калькулятору досрочного" });
    }
  }
  return h`<div class="r-msg ok"><b>Ближайшие 90 дней без кассовых разрывов.</b>
    <span>Свободно до <b class="num">${rub(free)}</b> сверх подушки ${rub(f.cushion)}. Кредит сейчас не нужен — вот что выгоднее:</span>
    ${tips.length ? h`<div class="tips">${tips.map((x) => h`<div class="tip ${x.k}"><b>${x.t}</b><span>${x.d}</span><div class="row wrapx" style="gap:8px">${x.ext ? h`<a class="btn sm" href="${x.href}" target="_blank" rel="noopener">${x.btn} ↗</a>` : h`<a class="btn sm" href="${x.href}">${x.btn} →</a>`}${x.href2 ? h`<a class="btn sm" href="${x.href2}" target="_blank" rel="noopener">${x.btn2} ↗</a>` : ""}</div></div>`)}</div>` : h`<span class="muted small">Продолжайте в том же духе: подушка на месте, обязательные платежи покрыты.</span>`}</div>`;
}
const dayIndex = (today, iso) => Math.round((new Date(iso) - new Date(today)) / 864e5);
let radarScenario = "base";
// оптимистичный и пессимистичный сценарии = базовый ± коридор изменчивости оборотов клиента
async function loadScenarios(base) {
  const d = Math.min(0.5, Math.max(0.1, base.band || 0.2));
  const [opt, pes] = await Promise.all([api("/client/forecast?scenario=" + d).catch(() => null), api("/client/forecast?scenario=" + (-d)).catch(() => null)]);
  return { base, opt: opt || base, pes: pes || base, delta: d };
}
function radarCard(fs, prod) {
  if (!fs || !fs.base) return h`<div class="card radar"><h2>Финансовый радар</h2><p class="muted">Прогноз недоступен.</p></div>`;
  const f = fs[radarScenario] || fs.base, g = f.gap, o = f.offer, dpct = Math.round(fs.delta * 100);
  const scn = [["opt", "Оптимистичный +" + dpct + " %"], ["base", "Базовый"], ["pes", "Пессимистичный −" + dpct + " %"]];
  const msg = g ? h`<div class="r-msg bad"><b>Через ${g.day} ${plural(g.day, "день", "дня", "дней")} возможен кассовый разрыв около ${rub(g.amount)}.</b>
      <span>${dateOnly(g.date)} остаток упадёт ниже подушки ${rub(f.cushion)}; минимум ${rub(g.lowest_balance)} ${dateOnly(g.lowest_date)}.
      ${o ? h`Закрыть дешевле всего: <b>${prod[o.product]?.title ?? o.product}</b> на ${rub(o.amount)}${o.product === "overdraft" ? " — проценты только за дни использования" : ""}, ставка от ${pct(o.rate_from)}.` : "Подходящий продукт подберём в заявке."}</span>
      ${o ? h`<a class="btn primary" href="#/client/new?product=${o.product}&amount=${o.amount}&term=${o.term}&purpose=gap">Подключить к ${dateOnly(g.date)} →</a>` : h`<a class="btn primary" href="#/client/products">Подобрать продукт →</a>`}</div>`
    : surplusAdvice(f, fs, prod);
  return h`<div class="card radar"><div class="row between wrapx"><div><h2>Финансовый радар</h2><div class="muted small">Поступления за 12 месяцев, прогноз на 3 и остаток на счёте на 90 дней вперёд</div></div>
      <div class="row wrapx" style="gap:8px"><div class="ptabs scn" aria-label="Диапазон">${Object.entries(RADAR_RANGES).map(([k, [, t]]) => h`<button class="ptab ${k === radarRange ? "sel" : ""}" data-act="radar-range" data-k="${k}">${t}</button>`)}</div>
      <div class="ptabs scn" aria-label="Сценарий">${scn.map(([v, t]) => h`<button class="ptab ${v === radarScenario ? "sel" : ""}" data-act="radar-scn" data-v="${v}">${t}</button>`)}</div></div></div>
    ${radarChart(f)}
    <div class="r-legend small muted"><span><i class="sw t"></i>поступления</span><span><i class="sw now"></i>текущий месяц</span><span><i class="sw drop"></i>падение ≥ 20 % к прошлому месяцу</span><span><i class="sw tf"></i>прогноз* с коридором</span><span><i class="sw gd"></i>среднее за год ${rub(Math.round(f.fact.reduce((a2, b2) => a2 + b2, 0) / 12))}</span></div>
    <div class="r-sub"><b>Остаток на счёте, 90 дней</b> <span class="muted small">· сейчас ${rub(f.balance)} · минимум ${rub(Math.min(...f.path.map((p) => p.balance)))}</span></div>
    ${balanceChart(f, fs)}
    <div class="r-legend small muted"><span><i class="sw g"></i>остаток — ${scn.find(([v]) => v === radarScenario)[1].toLowerCase()}</span><span><i class="sw thin"></i>два других сценария</span><span><i class="sw gd"></i>подушка — месяц обязательных платежей</span><span><i class="sw r"></i>платежи по кредитам</span></div>
    ${msg}
    ${f.factors ? h`<details class="r-factors"><summary><b>Что учитывает радар</b> <span class="muted small">· рынок, активность, финансы, репутация · подушка ×${f.cushion_multiplier}, коридор ±${Math.round(f.band * 100)} %</span></summary>
      <div class="r-fgrid">${f.factors.map((x) => h`<div class="r-f ${x.effect.startsWith("без") || x.effect.startsWith("коридор") ? "" : "warn"}"><b>${x.title}</b><span>${x.value}</span><em>${x.effect}</em><small>в проде: ${x.source}</small></div>`)}</div></details>` : ""}
    <p class="hint">Модель прозрачная: сезонность того же месяца год назад × тренд полугодия × маржа отрасли; расходы — в дни зарплат, аренды и поставщиков; списания — по графику платежей. Прогноз, не гарантия.</p></div>`;
}

// ---------- «Умный лимит»: одна сумма платёжеспособности на все продукты + что её поднимет ----------
function limitCard(l, prod) {
  if (!l) return "";
  if (!l.limit) return h`<div class="card limitcard"><h2>Умный лимит</h2><p class="muted">Лимит пока не рассчитан: не хватает данных источников. Подайте заявку — рассмотрим вручную.</p>
    ${l.growth.length ? h`<ul class="growth">${l.growth.map((g) => h`<li><b>${g.title}</b><span class="muted small">${g.how}</span></li>`)}</ul>` : ""}</div>`;
  const usedPct = Math.min(100, Math.round(l.used / l.limit * 100));
  return h`<div class="card limitcard"><div class="row between wrapx"><h2>Умный лимит</h2><span class="chip violet">одна проверка — все продукты</span></div>
    <div class="lim-big num" data-count="${l.limit}">${rub(l.limit)}</div>
    <div class="lim-bar" role="progressbar" aria-valuenow="${usedPct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${usedPct}%"></span></div>
    <div class="row between small muted"><span>использовано ${rub(l.used)}</span><span>доступно <b class="num">${rub(l.available)}</b></span></div>
    <div class="lim-products">${l.products.map((p) => h`<a class="chip" href="#/client/new?product=${p.product}" title="до ${rub(p.max_amount)}">${prod[p.product]?.title ?? p.product} · до ${rub(p.max_amount)}</a>`)}</div>
    <h3 class="mt">Как вырастить лимит</h3>
    <ul class="growth">${l.growth.map((g) => h`<li><div><b>${g.title}</b><span class="muted small">${g.how}</span></div><span class="eff ${g.effect ? "" : "muted"}">${g.effect ? "+" + rub(g.effect) : "уточним после"}</span></li>`)}</ul>
    <p class="hint">${l.note}. Комфортный платёж до ${rub(l.p_max)} в месяц.</p></div>`;
}


// мини-график остатка долга по графику платежей (оплаченная часть — сплошная)
function balanceSpark(rows, l) {
  const W = 600, H = 72, pad = 4, n = rows.length, max = l.amount;
  const pts = [[0, l.amount], ...rows.map((r, i) => [i + 1, r.balance])];
  const x = (i) => pad + (i / n) * (W - pad * 2), y = (v) => H - pad - (v / max) * (H - pad * 2);
  const path = pts.map(([i, v], k) => (k ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
  const paid = l.paid_count, xp = x(paid);
  return h`<div class="spark" aria-label="Остаток долга по месяцам"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path d="${path} L${x(n)} ${H} L0 ${H} Z" class="sp-area"/><path d="${path}" class="sp-line"/>
      <line x1="${xp}" y1="0" x2="${xp}" y2="${H}" class="sp-now"/><circle cx="${xp}" cy="${y(l.outstanding)}" r="4" class="sp-dot"/></svg>
    <div class="row between small muted"><span>выдача · ${rub(l.amount)}</span><span>сейчас · ${rub(l.outstanding)}</span><span>${rows.length} платежей · ${dateOnly(rows[rows.length - 1].date)}</span></div></div>`;
}

// досрочное погашение: предварительный расчёт двух сценариев (аннуитет, без комиссий)
const annuity = (S, r, n) => (r ? S * r / (1 - Math.pow(1 + r, -n)) : S / n);
function prepayCalc(l) {
  if (l.repaid || !l.next_payment) return "";
  const rem = l.total_count - l.paid_count, r = l.rate / 1200, P = l.next_payment.amount, step = Math.max(10000, Math.round(l.outstanding / 20 / 10000) * 10000);
  const extra = Math.min(prepayAmt[l.app_id] ?? Math.min(step * 5, l.outstanding - P), l.outstanding - P);
  const left = l.outstanding - extra, curInt = P * rem - l.outstanding;
  const newP = annuity(left, r, rem), savePay = curInt - (newP * rem - left);
  const nNew = left * r < P ? Math.max(1, Math.ceil(-Math.log(1 - left * r / P) / Math.log(1 + r))) : rem, saveTerm = curInt - (P * nNew - left);
  return h`<details class="prepay island mt"><summary><b>Погасить досрочно</b> <span class="muted small">· предварительный расчёт: уменьшить платёж или сократить срок</span></summary>
    <div class="calc-field mt"><label for="pp-${l.app_id}">Сумма досрочного взноса, ₽</label>
      <input id="pp-${l.app_id}" type="number" min="${step}" max="${l.outstanding - P}" step="${step}" value="${extra}" data-act="prepay-amt" data-app="${l.app_id}" data-fresh="1">
      <input type="range" min="${step}" max="${l.outstanding - P}" step="${step}" value="${extra}" data-act="prepay-amt" data-app="${l.app_id}" aria-label="Сумма досрочного взноса" data-fresh="1"></div>
    <div class="grid g2 mt"><div class="opt"><span class="muted small">Уменьшить платёж</span><div class="big num">${rub(newP)}<small class="muted"> / мес.</small></div><div class="small">было ${rub(P)} · срок прежний, ${rem} мес.</div><div class="small ok-text">экономия на процентах ${rub(Math.max(0, savePay))}</div></div>
      <div class="opt"><span class="muted small">Сократить срок</span><div class="big num">${nNew} мес.<small class="muted"> вместо ${rem}</small></div><div class="small">платёж прежний, ${rub(P)}</div><div class="small ok-text">экономия на процентах ${rub(Math.max(0, saveTerm))}</div></div></div>
    <p class="hint">Расчёт по аннуитетной формуле без комиссий, не оферта. Досрочное погашение оформляется заявлением — в прототипе операция не выполняется.</p></details>`;
}
const prepayAmt = {};
function repaintSection() { const box = $("#ctab"); if (!box || !window.__client) return; box.innerHTML = clientSection(clientTab, window.__client).s; animateCounts(box); initCarousels(); }

// уведомления внутри продукта: напоминание о платеже + события по заявкам (без SMS и email)
function buildNotifs(c) {
  const out = [];
  for (const l of c.prof.loans) if (!l.repaid && l.next_payment) out.push({ ts: new Date().toISOString(), kind: "pay", title: `Платёж ${rub(l.next_payment.amount)} до ${dateOnly(l.next_payment.date)}`, text: `${l.product_title} · платёж №${l.next_payment.n} из ${l.total_count}`, href: "#/client/loans" });
  for (const a of c.apps.slice(0, 6)) { const d = c.det?.[a.id]; if (!d?.events) continue;
    for (const e of d.events.slice(-4)) out.push({ ts: e.ts, kind: a.status.terminal ? "done" : a.status.turn === "client" ? "need" : "info", title: a.product_title + " · " + a.id, text: e.message, href: "#/client/app/" + a.id }); }
  out.sort((p, q) => (p.kind === "pay") - (q.kind === "pay") || (q.ts > p.ts ? 1 : -1));
  return out.slice(0, 10);
}
const notifSeen = () => { try { return localStorage.getItem("notif-seen") || ""; } catch { return ""; } };
const notifUnread = () => (window.__notifs || []).filter((n) => n.kind === "pay" ? !feedHidden("pay-seen") : n.ts > notifSeen()).length;
function notifPanel() {
  const list = window.__notifs || [];
  return h`<div id="notif-panel" role="dialog" aria-label="Уведомления"><div class="row between"><b>Уведомления</b><button class="btn sm" data-act="notif-close" aria-label="Закрыть">×</button></div>
    ${list.length ? list.map((n) => h`<a class="ntf ${n.kind}" href="${n.href}" data-act="notif-go"><span class="nd"></span><div><b>${n.title}</b><div class="small muted">${n.text}</div><div class="small faint">${n.kind === "pay" ? "напоминание" : dt(n.ts)}</div></div></a>`) : h`<p class="muted small">Пока тихо: уведомления о статусе заявки, одобрении и платежах появятся здесь.</p>`}
    <p class="hint">Уведомления только внутри кабинета — без SMS и почты.</p></div>`;
}

async function viewClient(tab = "overview") {
  const [prof, apps, cat] = await Promise.all([api("/client/profile"), api("/client/applications"), api("/products")]);
  const prod = Object.fromEntries(cat.products.map((p) => [p.id, p]));
  const active = apps.find((a) => !a.status.terminal);
  const cn = prof.company;
  clientTab = CLIENT_TABS.some(([k]) => k === tab) ? tab : "overview";
  const ids = [...new Set([...prof.loans.map((l) => l.app_id), ...apps.slice(0, 6).map((a) => a.id)])];
  const det = Object.fromEntries((await Promise.all(ids.map((id) => api("/client/applications/" + id).then((d) => [id, d]).catch(() => [id, null])))));
  const [base, limit] = await Promise.all([api("/client/forecast").catch(() => null), api("/client/limit").catch(() => null)]);
  const forecast = base ? await loadScenarios(base) : null;
  window.__prof = prof; window.__client = { prof, apps, cat, prod, active, det, forecast, limit };
  window.__notifs = buildNotifs(window.__client);
  stopPoll();
  render(h`${raw(topbar())}<main class="wrap">
    <div class="card head mb"><div class="row between wrapx"><div><h1>${cn.name}</h1>
      <div class="muted">ИНН ${cn.inn} · ${cn.okved} · в банке ${prof.tenure_months} мес. · ${cn.tax_regime}</div></div>
      <a class="keyrate" href="https://cbr.ru/hd_base/KeyRate/" target="_blank" rel="noopener" title="Ключевая ставка Банка России — от неё считается ставка по кредиту"><small>Ключевая ставка ЦБ</small><b>${pct(prof.key_rate)}</b></a></div>
    <nav class="ptabs client-tabs" aria-label="Разделы кабинета">${CLIENT_TABS.map(([k, t]) => h`<a class="ptab ${k === clientTab ? "sel" : ""}" href="#/client/${k}" data-act="client-tab" data-k="${k}">${t}${k === "loans" && active ? raw('<span class="cnt hot">1</span>') : ""}</a>`)}</nav></div>
    <div id="ctab" data-tab="${clientTab}">${clientSection(clientTab, window.__client)}</div></main>`);
  initCarousels();
}

// ---------- клиент: новая заявка ----------
let draft = null;
const PURPOSES = [
  { id: "stock", title: "Закупка товара, материалов", product: "working" },
  { id: "gap", title: "Кассовый разрыв", product: "overdraft" },
  { id: "equip", title: "Оборудование, транспорт, ремонт", product: "development" },
  { id: "other", title: "Другое", product: "working" },
];

async function viewNew(params) {
  stopPoll();
  const [prof, cat] = await Promise.all([api("/client/profile"), api("/products")]);
  if (!draft) draft = { step: 1, product: params.get("product") || null, purpose: null, amount: 1000000, term: 12, collateral: "none", purpose_text: "", consents: { pd: false, bureau: false, fns: false } };
  if (params.get("product") && !draft.product) draft.product = params.get("product");
  if (params.get("amount")) draft.amount = Math.max(1, +params.get("amount") || draft.amount);
  if (params.get("term")) draft.term = Math.max(1, +params.get("term") || draft.term);
  if (params.get("purpose") && PURPOSES.some((x) => x.id === params.get("purpose"))) { draft.purpose = params.get("purpose"); if (!draft.purpose_text && params.get("purpose") === "gap") draft.purpose_text = "Кассовый разрыв по прогнозу финансового радара"; }
  draft.cat = cat; draft.prof = prof;
  paintNew();
}

function paintNew() {
  const d = draft, prod = Object.fromEntries(d.cat.products.map((p) => [p.id, p])), p = prod[d.product];
  const steps = ["Цель и продукт", "Сумма и срок", "Проверка и отправка"];
  const rec = d.purpose ? PURPOSES.find((x) => x.id === d.purpose).product : null;
  let body = "";
  if (d.step === 1) {
    body = h`<h2>Рассчитаем кредит под вашу задачу</h2>
      <div class="task-grid"><div class="task-left">
        <div class="task-label">На что нужны средства?</div>
        <div class="task-pills">${PURPOSES.map((x) => h`<button class="pill ${d.purpose === x.id ? "sel" : ""}" data-act="purpose" data-id="${x.id}">${x.title}</button>`)}</div>
        <div class="field mt"><label for="ptext">Расскажите своими словами (необязательно)</label><textarea id="ptext" data-bind="purpose_text" placeholder="Например: закупить партию муки на два месяца вперёд">${d.purpose_text}</textarea></div>
      </div><div class="task-right">
      <h3 class="task-title">Подходящий продукт</h3>${rec ? h`<p class="muted small">По вашей цели рекомендуем «${prod[rec].title}» — отмечено ниже.</p>` : h`<p class="muted small">Выберите задачу слева — подскажем продукт.</p>`}
      <div class="grid g2">${d.cat.products.map((x) => h`<button class="prod ${d.product === x.id ? "sel" : ""}" data-act="pick-product" data-id="${x.id}" ${x.eligible ? "" : "disabled"}>
        <img class="pimg sm" src="img/products/${x.id}.webp" alt="" width="512" height="512" loading="lazy" decoding="async"><h3>${x.title} ${rec === x.id ? raw('<span class="chip accent">рекомендуем</span>') : ""} ${x.id === "preferential" && x.eligible ? raw('<span class="chip ok">вам доступно</span>') : ""}</h3>
        <div class="muted small">${x.tagline}</div>
        <div class="small mt">${x.kind === "limit" ? "Лимит" : "Сумма"}: ${rub(x.min_amount)} – ${rub(x.max_amount)}${x.kind === "limit" ? "" : " · срок " + x.min_term + "–" + x.max_term + " мес."}</div>
        ${x.eligible ? "" : h`<div class="small" style="color:var(--bad)">Недоступно для вашей компании</div>`}</button>`)}</div></div></div>
      <div class="row mt2"><span class="spacer"></span><button class="btn primary" data-act="step" data-to="2" ${d.product ? "" : "disabled"}>Далее →</button></div>`;
  } else if (d.step === 2) {
    const limit = p.kind === "limit";
    body = h`<h2>${limit ? "Какой лимит нужен?" : "Сколько и на какой срок?"}</h2>
      <div class="grid g2"><div class="calc-field"><label for="amt">${limit ? "Лимит" : "Сумма"}, ₽</label><input id="amt" type="number" min="${p.min_amount}" max="${p.max_amount}" step="50000" value="${d.amount}" data-bind="amount" data-fresh="1">
        <input type="range" aria-label="Сумма" min="${p.min_amount}" max="${p.max_amount}" step="50000" value="${d.amount}" data-bind="amount" data-range="amt"><div class="calc-scale"><span>${rub(p.min_amount)}</span><span>${rub(p.max_amount)}</span></div></div>
        ${limit ? h`<div class="calc-field"><label>Срок договора</label><div class="calc-static">12 месяцев, транш до 60 дней</div></div>` :
          h`<div class="calc-field"><label for="trm">Срок, мес.</label><input id="trm" type="number" min="${p.min_term}" max="${p.max_term}" value="${d.term}" data-bind="term" data-fresh="1">
        <input type="range" aria-label="Срок" min="${p.min_term}" max="${p.max_term}" step="1" value="${d.term}" data-bind="term" data-range="trm"><div class="calc-scale"><span>${p.min_term} мес.</span><span>${p.max_term} мес.</span></div></div>`}</div>
      <div class="field mt"><label for="col">Обеспечение</label><select id="col" data-bind="collateral">${p.collateral_options.map((c) =>
        h`<option value="${c.id}" ${d.collateral === c.id ? "selected" : ""}>${c.label}</option>`)}</select>
        <div class="hint">${p.collateral_options.find((c) => c.id === d.collateral)?.hint} ${T("обеспечение", "Что такое обеспечение?")}</div></div>
      <div id="quote" class="card flat mt"><span class="muted">Считаем…</span></div>
      <div class="row mt2"><button class="btn" data-act="step" data-to="1">← Назад</button><span class="spacer"></span><button class="btn primary" data-act="step" data-to="3">Далее →</button></div>`;
    setTimeout(() => { refreshQuote(); document.querySelectorAll('input[type=range]').forEach(paintRange); }, 0);
  } else {
    const c = d.prof.company;
    body = h`<h2>Проверьте и отправьте</h2>
      <div class="grid g2"><div><h3>Заявка</h3><dl class="kv"><dt>Продукт</dt><dd>${p.title}</dd><dt>${p.kind === "limit" ? "Лимит" : "Сумма"}</dt><dd class="num">${rub(d.amount)}</dd>
        <dt>Срок</dt><dd>${p.kind === "limit" ? "12 мес." : d.term + " мес."}</dd><dt>Обеспечение</dt><dd>${p.collateral_options.find((c) => c.id === d.collateral)?.label}</dd></dl></div>
        <div><h3>О компании <span class="chip ok">из реестров и данных банка</span></h3><dl class="kv"><dt>Название</dt><dd>${c.name}</dd><dt>ИНН</dt><dd>${c.inn}</dd><dt>Руководитель</dt><dd>${c.director}</dd><dt>Счёт</dt><dd class="num">${c.account}</dd></dl>
        <p class="hint">Данные подтянуты автоматически — вводить повторно не нужно.</p></div></div>
      <hr><h3>Согласия</h3>
      <label class="check"><input type="checkbox" id="c_pd" data-bind-c="pd" ${d.consents.pd ? "checked" : ""}> Согласен на обработку персональных данных</label>
      <label class="check"><input type="checkbox" id="c_bureau" data-bind-c="bureau" ${d.consents.bureau ? "checked" : ""}> Согласен на запрос кредитной истории в бюро кредитных историй</label>
      <label class="check"><input type="checkbox" id="c_fns" data-bind-c="fns" ${d.consents.fns ? "checked" : ""}> Согласен на запрос сведений в ФНС и ЕГРЮЛ</label>
      <div class="notice plate mt">Заявка оценивается автоматически по прозрачным правилам. Если случай нестандартный, её рассмотрит специалист банка.</div>
      <div class="row mt2"><button class="btn" data-act="step" data-to="2">← Назад</button><span class="spacer"></span>
        <button class="btn primary" data-act="submit-app" ${d.consents.pd && d.consents.bureau && d.consents.fns ? "" : "disabled"}>Отправить заявку</button></div>`;
  }
  render(h`${raw(topbar())}<main class="wrap" style="max-width:860px"><a href="#/client" class="small">← Главная</a><h1 class="mt">Новая заявка</h1>
    <ol class="stepper">${["Заявка", "Проверка", "Решение", "Подписание", "Выдача"].map((s, i) => raw(`<li data-n="${i + 1}" class="${i === 0 ? "now" : ""}">${esc(s)}</li>`))}</ol>
    <div class="substep mb" aria-label="Шаги заявки"><span class="chip">Шаг ${d.step} из ${steps.length}</span> <span class="muted small">${steps[d.step - 1]}</span></div>
    <div class="card ${d.step === 1 || d.step === 2 ? "calc island" : ""}">${body}</div></main>`);
}

function paintRange(r) { const k = (r.value - r.min) / (r.max - r.min) * 100; r.style.setProperty("--fill", k + "%"); }
let quoteTimer;
function refreshQuote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(async () => {
    const box = $("#quote"); if (!box || !draft) return;
    const p = draft.cat.products.find((x) => x.id === draft.product);
    try {
      const q = await api("/client/quote", { body: { product: draft.product, amount: draft.amount, term: p.kind === "limit" ? 12 : draft.term, collateral: draft.collateral } });
      if (!$("#quote")) return;
      const fit = q.fits ? h`<span class="chip ok">✓ укладывается в платёжеспособность</span>` : h`<span class="chip warn">! выше комфортного платежа — банк может предложить другие условия</span>`;
      const prev = refreshQuote.prev || {}; refreshQuote.prev = q;
      $("#quote").innerHTML = h`<div class="grid g3">
        <div><div class="muted small">${T("ставка", "Ставка")}</div><div class="big">${pct(q.rate)}</div><div class="muted small">${q.collateral_effect > 0 ? "обеспечение снизило ставку на " + String(q.collateral_effect).replace(".", ",") + " п.п." : "без обеспечения ставка выше"}</div></div>
        ${p.kind === "limit" ? h`<div><div class="muted small">Плата за лимит</div><div class="big num" data-count="${q.fee}" data-from="${prev.fee || 0}">${rub(q.fee)}</div><div class="muted small">проценты за 30 дней при полном использовании ≈ ${rub(q.interest_30d)}</div></div>`
          : h`<div><div class="muted small">Платёж в месяц</div><div class="big num" data-count="${q.payment}" data-from="${prev.payment || 0}">${rub(q.payment)}</div><div class="muted small">${T("аннуитет", "аннуитет")}</div></div>
        <div><div class="muted small">${T("переплата", "Переплата")}</div><div class="big num" data-count="${q.overpayment}" data-from="${prev.overpayment || 0}">${rub(q.overpayment)}</div><div class="muted small">всего вернёте ${rub(q.total)}</div></div>`}</div>
      <div class="row wrapx mt">${fit}<span class="muted small">При таком сроке комфортная сумма — до ${rub(q.max_amount)}</span></div>
      <p class="hint">Предварительный расчёт, не оферта. Итоговые условия назовёт банк после проверки.</p>`.s;

    } catch (e) { box.textContent = e.message; }
  }, 250);
}

// ---------- клиент: заявка ----------
// полноэкранный момент выдачи: один раз на заявку в этой вкладке
// полноэкранная «галочка»: выдача кредита, внесённый платёж, полное погашение
function showCelebrate({ label, title, sum, sub, button, onButton, second, auto = 12000 }) {
  document.getElementById("issued-overlay")?.remove();
  const el = document.createElement("div"); el.id = "issued-overlay"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", label);
  el.innerHTML = h`<div class="iss-glow"></div>
    <div class="iss-body">
      <svg class="iss-check" viewBox="0 0 120 120" aria-hidden="true"><circle class="iss-ring" cx="60" cy="60" r="54"/><path class="iss-tick" d="M34 62 L52 80 L88 42"/></svg>
      <h1>${title}</h1>
      <p class="iss-sum">${sum}</p>
      <p class="iss-sub">${sub}</p>
      <div class="iss-actions"><button class="btn primary" data-act="issued-close">${button}</button>${second ? h`<button class="btn" data-act="issued-second">${second.label}</button>` : ""}</div>
    </div>`.s;
  document.body.appendChild(el); document.body.classList.add("iss-open");
  const close = () => { if (!el.isConnected) return; el.classList.add("out"); document.body.classList.remove("iss-open"); setTimeout(() => el.remove(), 500); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  el.addEventListener("click", (e) => {
    if (e.target.closest("[data-act=issued-second]")) { close(); second?.onClick?.(); return; }
    if (e.target.closest("[data-act=issued-close]")) { close(); onButton?.(); return; }
    if (e.target === el) close();
  });
  document.addEventListener("keydown", onKey);
  clearTimeout(showCelebrate._t); showCelebrate._t = setTimeout(close, auto);      // один таймер на все оверлеи: прошлый не закроет новый
}
function showIssued(a) {
  const key = "issued-shown-" + a.id;
  try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, "1"); } catch { /* приватный режим */ }
  const amt = rub(a.contract?.amount ?? a.offer?.amount ?? a.amount), od = a.product === "overdraft";
  showCelebrate({ label: od ? "Лимит открыт" : "Кредит выдан", title: od ? "Лимит открыт!" : "Кредит выдан!",
    sum: od ? h`Овердрафт ${amt} доступен на расчётном счёте — деньги списываются по мере использования` : h`${amt} уже на вашем расчётном счёте`,
    sub: a.contract?.first_payment ? h`Первый платёж ${rub(a.contract.first_payment.amount)} · ${dateOnly(a.contract.first_payment.date)}` : "График платежей и договор — в карточке кредита",
    button: "Смотреть график платежей", onButton: openSchedule, second: { label: "На главную", onClick: toHome } });
}
// раскрыть график платежей на странице заявки и прокрутить к нему
function openSchedule() {
  const d = document.getElementById("sched"); if (!d) return;
  d.open = true; setTimeout(() => d.scrollIntoView({ behavior: "smooth", block: "start" }), 350);
}
function showPaid(r, paid) {
  const l = r.loan;
  if (!l || l.repaid) return showCelebrate({ label: "Кредит погашен", title: "Кредит погашен полностью!", sum: h`Последний платёж ${rub(paid)} внесён — обязательств по договору больше нет`,
    sub: l ? h`Всего выплачено ${rub(l.total_paid)}, из них проценты ${rub(l.interest_paid)} · договор ${l.contract}` : "", button: "Отлично", auto: 9000 });
  showCelebrate({ label: "Платёж внесён", title: "Платёж внесён!", sum: h`${rub(paid)} списано с расчётного счёта · платёж №${l.paid_count} из ${l.total_count}`,
    sub: h`Следующий платёж ${rub(l.next_payment.amount)} · ${dateOnly(l.next_payment.date)} · остаток долга ${rub(l.outstanding)} · на счёте ${rub(r.balance)}`, button: "Продолжить", auto: 7000 });
}
let lastSig = "";
async function viewApp(id) {
  const a = await api("/client/applications/" + id);
  if (a.loan) a.account = await api("/client/account");
  const sig = a.id + a.status.code + a.events.length + a.updated + (a.account ? a.account.balance : "");
  if (sig === lastSig && $("#appview")) return;
  lastSig = sig;
  if (!$("#appview")) paintApp(a);
  else {  // смена статуса без мигания: приглушить, подменить, проявить
    const r = root(); r.classList.add("swap");
    await new Promise((res) => setTimeout(res, 320));
    paintApp(a, true); requestAnimationFrame(() => requestAnimationFrame(() => r.classList.remove("swap")));
  }
  if (a.status.code === "DISBURSED" && !a.loan?.repaid) showIssued(a);
  stopPoll();
  if (!a.status.terminal) poll = setInterval(() => viewApp(id).catch(() => {}), a.status.transient ? 1200 : 3000);
}

function offerCard(a) {
  const o = a.offer, limit = o.payment == null;
  const chg = (x, y) => (x !== y ? "chg" : "");
  const down = o.product && o.product !== a.product;
  return h`<div class="card mt island"><div class="row between wrapx"><h2>${down ? "Предлагаем другой продукт" : o.type === "AS_REQUESTED" ? "Одобрено на запрошенных условиях" : "Одобрено на других условиях"}</h2>
      <span class="chip ${o.type === "AS_REQUESTED" ? "ok" : "warn"}">${down ? "Другой продукт" : o.type === "AS_REQUESTED" ? "Одобрено" : "Другие условия"}</span></div>
    ${down ? h`<div class="notice warn mb">Запрошенный продукт на таких условиях не подходит. Мы подобрали «${o.product_title}» — он лучше соответствует вашей платёжеспособности и уровню риска. Можно принять предложение или подать новую заявку с другими параметрами.</div>` : ""}
    ${o.type === "COUNTER" ? h`<div class="notice warn mb">Мы подобрали условия, при которых платёж будет для бизнеса комфортным. ${o.term !== a.term ? "Срок увеличен — ставка для более длинного срока немного выше." : ""}</div>` : ""}
    <div class="keyline mb"><div><span class="muted small">${limit ? T("лимит", "Лимит") : T("платёж", "Платёж в месяц")}</span><div class="big num" data-count="1">${limit ? rub(o.amount) : rub(o.payment)}</div></div>
      <div><span class="muted small">${T("ставка", "Ставка")}</span><div class="big" data-count="1">${pct(o.rate)}</div></div>
      <div><span class="muted small">Срок</span><div class="big" data-count="1">${limit ? "12 мес." : o.term + " мес."}</div></div></div>
    <details ${o.type === "AS_REQUESTED" ? "" : "open"}><summary class="small muted" style="cursor:pointer">Сравнить с запрошенными условиями</summary>
    <table class="cmp"><thead><tr><th></th><th>Как просили</th><th>Как предлагаем</th></tr></thead><tbody>
      ${down ? h`<tr><td>Продукт</td><td>${a.product_title}</td><td class="chg">${o.product_title}</td></tr>` : ""}
      <tr><td>${limit ? "Лимит" : "Сумма"}</td><td class="num">${rub(a.amount)}</td><td class="num ${chg(a.amount, o.amount)}">${rub(o.amount)}</td></tr>
      <tr><td>Срок</td><td>${a.term} мес.</td><td class="${chg(a.term, o.term)}">${limit ? "12 мес." : o.term + " мес."}</td></tr>
      <tr><td>${T("ставка", "Ставка")}</td><td class="muted">—</td><td><b>${pct(o.rate)}</b></td></tr>
      <tr><td>${T("обеспечение", "Обеспечение")}</td><td>${a.collateral_label_requested || "—"}</td><td>${a.collateral_label}</td></tr>
      ${limit ? h`<tr><td>Плата за лимит</td><td></td><td class="num">${rub(o.fee)}</td></tr>` :
        h`<tr><td>Платёж в месяц</td><td class="muted">—</td><td class="num"><b>${rub(o.payment)}</b></td></tr><tr><td>${T("переплата", "Переплата")}</td><td></td><td class="num">${rub(o.overpayment)}</td></tr>`}
    </tbody></table></details>
    <p class="hint">${o.fee_text}. Предложение действует до ${dateOnly(o.valid_until)}. Ключевая ставка на момент расчёта: ${pct(o.key_rate_snapshot)}.</p>
    ${a.status.code === "OFFER_READY" ? h`<div class="row wrapx mt"><button class="btn primary" data-act="accept">Принять предложение</button>
      <button class="btn danger" data-act="decline-offer">Отказаться</button></div>` : ""}</div>`;
}

function reasonsCard(a, title) {
  if (!a.reasons.length) return "";
  const helped = a.reasons.filter((r) => r.direction === "helped"), hurt = a.reasons.filter((r) => r.direction !== "helped");
  const row = (r) => h`<div class="reason ${r.direction}"><span class="ic">${r.direction === "helped" ? "✓" : "!"}</span><div>${r.text}${r.action ? h`<div class="act">Что можно сделать: ${r.action}</div>` : ""}</div></div>`;
  return h`<div class="card mt"><h2>${title}</h2>${helped.map(row)}${hurt.map(row)}</div>`;
}

function scheduleTable(a) {
  if (!a.schedule) return "";
  const rows = a.schedule, sum = (k) => rows.reduce((t, r) => t + r[k], 0), disb = a.status.code === "DISBURSED";
  const mx = Math.max(...rows.map((r) => r.payment)), over = sum("interest"), princ = sum("principal");
  const viz = h`<div class="sched-viz mt"><div class="row between wrapx small"><span><i class="sw p"></i>основной долг ${rub(princ)}</span><span><i class="sw i"></i>проценты ${rub(over)} · переплата ${Math.round(over / princ * 100)} %</span><span class="muted">всего ${rub(princ + over)}</span></div>
    <div class="sv-bars" role="img" aria-label="Структура каждого платежа: основной долг и проценты">${rows.map((r) => h`<div class="sv-col ${r.paid ? "paid" : ""}" title="№${r.n} · ${dateOnly(r.date)} · долг ${rub(r.principal)} · проценты ${rub(r.interest)}"><span class="i" style="height:${(r.interest / mx * 100).toFixed(1)}%"></span><span class="p" style="height:${(r.principal / mx * 100).toFixed(1)}%"></span></div>`)}</div>
    <div class="row between small muted"><span>${dateOnly(rows[0].date)}</span><span>доля процентов в платеже падает с ${Math.round(rows[0].interest / rows[0].payment * 100)} % до ${Math.round(rows[rows.length - 1].interest / rows[rows.length - 1].payment * 100)} %</span><span>${dateOnly(rows[rows.length - 1].date)}</span></div></div>`;
  return h`<details class="mt" id="sched" ${disb ? "open" : ""}><summary><b>${T("график платежей", "График платежей")}</b> <span class="muted small">· платежей: ${rows.length}${disb ? " · оплачено: " + rows.filter((r) => r.paid).length : ""}</span></summary>${viz}
    <div class="scroll mt"><table class="t sched"><thead><tr><th>№</th><th>Дата платежа</th><th class="right">${T("основной долг", "Основной долг")}</th><th class="right">${T("проценты", "Проценты")}</th><th class="right">Платёж</th><th class="right">${T("остаток долга", "Остаток долга")}</th>${disb ? h`<th class="center">Оплата</th>` : ""}</tr></thead><tbody>
    ${rows.map((r) => h`<tr class="${r.paid ? "paid" : ""}"><td>${r.n}</td><td>${dateOnly(r.date)}</td><td class="right num">${rub(r.principal)}</td><td class="right num">${rub(r.interest)}</td><td class="right num"><b>${rub(r.payment)}</b></td><td class="right num">${rub(r.balance)}</td>${disb ? h`<td class="center">${r.paid ? raw('<span class="tick" title="Оплачен">✓</span>') : ""}</td>` : ""}</tr>`)}
    </tbody><tfoot><tr><td colspan="2"><b>Итого</b></td><td class="right num"><b>${rub(sum("principal"))}</b></td><td class="right num"><b>${rub(sum("interest"))}</b></td><td class="right num"><b>${rub(sum("payment"))}</b></td><td></td>${disb ? h`<td></td>` : ""}</tr></tfoot></table></div>
    <button class="btn sm mt" data-act="csv">Скачать CSV</button></details>`;
}

function paintApp(a, silent = false) {
  window.__app = a;
  const s = a.status, code = s.code;
  const good = code === "DISBURSED", bad = code === "DECLINED";
  let ctx = "";
  if (code === "AWAITING_DOCS") {
    ctx = h`<div class="card mt"><h2>Что нужно от вас</h2><p>${a.doc_request?.text}</p>
      <div class="row between wrapx card flat"><div><b>Выписка по расчётному счёту из другого банка</b><div class="muted small">Зачем: подтвердить обороты и ускорить решение. Где взять: в интернет-банке другого банка, за последние 12 месяцев.</div></div>
        <span class="chip warn">Нужно</span></div>
      <div class="field mt"><label for="note">Комментарий (необязательно)</label><textarea id="note"></textarea></div>
      <button class="btn primary" data-act="docs">Подключить выписку (демо)</button>
      <p class="hint">В демо вместо реальной загрузки файла выписка подключается автоматически.</p></div>`;
  } else if (code === "OFFER_READY" || code === "AWAITING_SIGNATURE" || code === "DISBURSING" || code === "DISBURSED") {
    ctx = h`${offerCard(a)}${reasonsCard(a, "Почему такое решение")}`;
  } else if (code === "MANUAL_REVIEW") {
    ctx = h`<div class="card mt"><h2>Что происходит</h2><p>Заявка передана специалисту банка для дополнительной проверки. Ничего делать не нужно — ответим в этом кабинете.</p>
      ${a.reasons.map((r) => h`<div class="reason hurt"><span class="ic">i</span><div>${r.text}${r.action ? h`<div class="act">${r.action}</div>` : ""}</div></div>`)}</div>`;
  } else if (bad) {
    ctx = h`${reasonsCard(a, "Что повлияло на решение")}<div class="card mt"><p class="muted">Решение принято автоматически по правилам банка. Если вы не согласны, обратитесь к менеджеру банка — заявку может пересмотреть специалист.</p>
      <button class="btn primary" data-act="to-new">Подать новую заявку</button></div>`;
  }
  if (code === "AWAITING_SIGNATURE") {
    ctx = h`${ctx}<div class="card mt"><h2>Подписание</h2>
      <div class="grid g3 mb docs">${[["договор", "Кредитный договор"], ["согласие на обработку данных", "Согласие на обработку данных"], ["график платежей", "График платежей"]].map(([k, x]) => h`<div class="card flat small"><div class="doc-t"><span class="doc-ico" aria-hidden="true">📄</span><span>${k ? T(k, x) : x}</span></div><span class="chip">готов</span></div>`)}</div>
      <div class="notice mb"><b>Вы подписываете:</b> ${a.offer.payment == null ? h`${T("лимит", "лимит")} ${rub(a.offer.amount)}` : h`кредит ${rub(a.offer.amount)} на ${a.offer.term} мес.`}, ${T("ставка", "ставка")} ${pct(a.offer.rate)}${a.offer.payment ? h`, ${T("платёж", "платёж")} ${rub(a.offer.payment)} в месяц, ${T("переплата", "переплата")} ${rub(a.offer.overpayment)}` : ""}; ${T("обеспечение", "обеспечение")}: ${a.collateral_label.toLowerCase()}. ${T("досрочное погашение", "Досрочное погашение")} без штрафа. Наведите курсор на подчёркнутое слово, чтобы увидеть пояснение.</div>
      <p>Подтвердите подписание кодом — это ${T("простая электронная подпись", "простая электронная подпись")} (имитация): код показан на экране.</p>
      <div class="row wrapx"><div>Код (демо): <span class="code">${a.sign_code}</span></div></div>
      <div class="field mt" style="max-width:260px"><label for="code">Введите код</label><input id="code" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>
      <button class="btn primary" data-act="sign">Подписать договор</button></div>`;
  }
  if (good) {
    ctx = h`<div class="card mt issued"><h2>${a.loan?.repaid ? "Кредит погашен" : "Кредит выдан"}</h2><dl class="kv">
      <dt>Договор</dt><dd>${a.contract.number} от ${dateOnly(a.contract.date)}</dd><dt>Сумма</dt><dd class="num">${rub(a.contract.amount)}</dd>
      <dt>Зачислено на счёт</dt><dd class="num">${a.contract.account}</dd><dt>Ставка</dt><dd>${pct(a.contract.rate)}</dd>
      ${a.contract.first_payment ? h`<dt>Первый платёж</dt><dd class="num">${rub(a.contract.first_payment.amount)} · ${dateOnly(a.contract.first_payment.date)}</dd>` : ""}</dl>
      <p class="hint">${a.contract.note}</p></div>
      ${a.loan ? h`<div class="card mt"><h2>Мой кредит</h2>${loanBlock(a.loan, a.account)}
        <div class="row wrapx mt"><input id="topup" type="number" min="1000" max="5000000" step="1000" value="100000" aria-label="Сумма пополнения, ₽" style="max-width:180px"><button class="btn" data-act="topup">Пополнить счёт (демо)</button></div></div>` : ""}
      ${reasonsCard(a, "Почему такое решение")}`;
  }
  const tl = [...a.events].reverse();
  if (!silent) setTimeout(() => animateCounts(root()), 0);
  render(h`${raw(topbar())}<main class="wrap" id="appview"><a href="#/client" class="small">← Главная</a>
    <div class="row between wrapx mt mb"><div><h1>${a.product_title}</h1><div class="muted">${a.id} · ${rub(a.amount)}${a.product === "overdraft" ? " лимит" : " на " + a.term + " мес."} · подана ${dt(a.created)}</div></div></div>
    <div class="cols"><div>
      <div class="card status ${s.turn} ${good ? "good" : ""} ${bad ? "bad" : ""}">
        <div class="row between wrapx"><span class="chip ${s.turn === "client" ? "accent" : s.turn === "bank" ? "info" : ""}">${s.turn === "client" ? "Ждём вас" : s.turn === "bank" ? "Сейчас ход банка" : "Завершено"}</span>${s.transient ? raw('<span class="spin" aria-hidden="true"></span>') : ""}</div>
        <h1 class="mt">${s.title}</h1><p style="margin:0">${s.text}</p>
        <div class="hints mt">
          <div><span class="muted small">Что дальше</span><br>${s.next}</div>
          <div class="${s.turn === "client" ? "need" : ""}"><span class="muted small">Что нужно от вас</span><br><b>${s.need}</b></div>
          <div><span class="muted small">Когда</span><br>${s.eta}</div></div>
        <ol class="stepper mt2">${a.steps.map((x, i) => raw(`<li data-n="${i + 1}" class="${i < s.step ? "done" : i === s.step ? "now " + (good ? "good" : bad ? "bad" : s.turn === "client" ? "wait" : "") : ""}">${esc(x)}</li>`))}</ol></div>
      ${ctx}
      ${!s.terminal && code !== "DISBURSING" ? h`<p class="mt"><button class="btn link" data-act="withdraw">Отозвать заявку</button></p>` : ""}</div>
      <details class="card"><summary><b>История заявки</b> <span class="muted small">· последнее: ${tl[0].message}</span></summary><ul class="timeline mt">${tl.map((e, i) => h`<li class="${i === 0 ? "last" : ""}"><time>${dt(e.ts)}</time>${e.message}</li>`)}</ul></details></div></div>
    ${a.schedule ? h`<div class="card mt">${scheduleTable(a)}</div>` : ""}</main>`);
}

// ---------- банк ----------
let bankFilter = "all";
async function viewBank() {
  const [apps, st] = await Promise.all([api("/bank/applications"), api("/bank/stats")]);
  const admin = session.user.role === "admin";
  const settings = admin ? await api("/admin/settings") : null;
  const filt = { all: () => true, manual: (a) => a.status === "MANUAL_REVIEW", client: (a) => a.turn === "client", bank: (a) => a.turn === "bank", done: (a) => ["DISBURSED", "DECLINED", "WITHDRAWN", "EXPIRED"].includes(a.status) };
  const rows = apps.filter(filt[bankFilter]).sort((x, y) => (y.status === "MANUAL_REVIEW") - (x.status === "MANUAL_REVIEW") || new Date(y.updated) - new Date(x.updated));
  render(h`${raw(topbar())}<main class="wrap"><h1>Очередь заявок</h1>
    <div class="tiles mb"><div class="tile"><b data-count="1">${st.total}</b><span>всего заявок</span></div><div class="tile ${st.manual_queue ? "hot" : ""}"><b data-count="1">${st.manual_queue}</b><span>на ручном разборе</span></div>
      <div class="tile"><b data-count="1">${st.waiting_client}</b><span>ждут клиента</span></div><div class="tile"><b data-count="1">${st.disbursed}</b><span>выдано</span></div><div class="tile"><b data-count="1">${st.declined}</b><span>отказано</span></div></div>
    ${admin ? h`<details class="card mb"><summary><b>Пульт стенда</b> <span class="muted small">— ключевая ставка, режим БКИ, скорость конвейера, сброс данных</span></summary>
      <div class="grid g4 mt"><div class="field"><label for="kr">Ключевая ставка, %</label><input id="kr" type="number" step="0.25" value="${settings.key_rate}"></div>
        <div class="field"><label for="bm">БКИ</label><select id="bm"><option value="ok" ${settings.bureau_mode === "ok" ? "selected" : ""}>Работает</option><option value="down" ${settings.bureau_mode === "down" ? "selected" : ""}>Сбой (таймаут)</option></select></div>
        <div class="field"><label for="sd">Пауза между этапами, с</label><input id="sd" type="number" step="0.2" min="0" max="10" value="${settings.step_delay}"></div>
        <div class="field"><label for="dm">Режим решения</label><select id="dm"><option value="rules" ${settings.decision_mode === "rules" ? "selected" : ""}>Правила: скоркарта и политика</option><option value="ml_cascade" ${settings.decision_mode === "ml_cascade" ? "selected" : ""}>PD-модель и каскад по продуктам</option></select></div></div>
      <p class="small muted">Источник PD для каскада: <b>${settings.ml.source === "ml" ? "ML-модель " + settings.ml.version : "скоркарта (обученной модели нет — запасной режим)"}</b></p>
      <button class="btn primary sm" data-act="save-settings">Применить</button> 
      <button class="btn danger sm" data-act="reset">Сбросить демо-данные</button></details>` : ""}
    <div class="ftabs mb">${[["all", "Все"], ["manual", "Ручной разбор"], ["client", "Ждём клиента"], ["bank", "В работе у банка"], ["done", "Завершённые"]].map(([k, t]) => {
      const n = apps.filter(filt[k]).length;
      return h`<button class="ftab ${bankFilter === k ? "sel" : ""}" data-act="filter" data-k="${k}">${t}<span class="cnt ${k === "manual" && n ? "hot" : ""}">${n}</span></button>`; })}</div>
    <div class="card scroll" style="padding:4px 12px 8px"><table class="t queue"><thead><tr><th>Заявка</th><th>Клиент</th><th>Продукт</th><th class="right">Сумма / срок</th><th>Этап</th><th>Ход</th><th>Оценка</th><th>Обновлено</th></tr></thead><tbody>
    ${rows.length ? rows.map((a) => h`<tr class="click ${a.status === "MANUAL_REVIEW" ? "focus" : ""}" data-act="open-bank" data-id="${a.id}">
      <td><b>${a.id}</b></td><td>${a.client}<br><span class="muted small">ИНН ${a.inn}</span></td><td>${a.product_title}</td><td class="right num">${rub(a.amount)}<br><span class="muted small">${a.term} мес.</span></td>
      <td>${chip(a.status, a.status_title)}</td><td>${{ client: "Клиент", bank: "Банк", none: "—" }[a.turn]}</td>
      <td>${a.grade ? h`<span class="grade ${a.grade}">${a.grade}</span> <span class="num muted">${a.score}</span>` : "—"}</td><td class="muted small">${ago(a.updated)}</td></tr>`)
      : h`<tr><td colspan="8" class="center muted" style="padding:32px">Заявок нет. Войдите как клиент и подайте заявку.</td></tr>`}</tbody></table></div></main>`);
  stopPoll(); poll = setInterval(() => { if (location.hash === "#/bank" && !document.querySelector("details[open]")) route(true); }, 4000);
}

function factorBars(factors) {
  const blocks = [...new Set(factors.map((f) => f.block))];
  return h`<div class="bars">${blocks.map((b) => {
    const fs = factors.filter((f) => f.block === b), got = fs.reduce((s, f) => s + f.points, 0), mx = fs.reduce((s, f) => s + f.max, 0);
    return h`<h3>${b} — ${got} из ${mx}</h3>${fs.map((f) => {
      const r = f.points / f.max;
      return h`<div class="b"><span>${f.id} ${f.name}</span><span class="track"><span class="fill ${r < 0.34 ? "low" : r < 0.67 ? "mid" : ""}" style="display:block;width:${Math.max(r * 100, 2)}%"></span></span><span class="num right">${f.points}/${f.max}</span><span class="sub">${f.value}</span></div>`;
    })}`;
  })}</div>`;
}

const ZONE = { approve: ["ok", "Автоодобрение"], grey: ["warn", "Серая зона"], skip: ["bad", "Пропуск"] };
const FEAT = { age_months: "возраст бизнеса", tenure_months: "стаж в банке", avg_receipts_log: "поступления", ncf_log: "денежный поток", receipts_cv: "нестабильность поступлений",
  min_to_avg: "провальные месяцы", last3_to_avg: "последние 3 месяца", receipts_dynamics: "динамика", existing_payments_share: "нагрузка по кредитам", payment_to_ncf: "платёж к потоку",
  amount_to_avg_receipts: "сумма к оборотам", amount_to_annual_receipts: "сумма к годовым оборотам", bureau_max_overdue_24m: "просрочка в БКИ", bureau_current_overdue_days: "текущая просрочка",
  bureau_inquiries_3m: "обращения за кредитом", bureau_history_months: "история в БКИ", bureau_active_loans: "действующие кредиты", bureau_available: "наличие данных БКИ",
  tax_debt_log: "налоговый долг", tax_debt_days: "срок налогового долга", courts_ratio: "иски", amount_log: "размер суммы", term: "срок", product: "продукт", industry: "отрасль",
  collateral: "обеспечение", statement_source: "источник выписки", statement_months: "глубина выписки", legal_form: "форма", msp_registry: "реестр МСП", priority_industry: "приоритетная отрасль" };
function mlCard(dec) {
  const ml = dec.ml, src = ml.source === "ml";
  return h`<div class="card mt"><div class="row between wrapx"><h2>PD-модель и каскад по продуктам</h2>
      <span class="chip ${src ? "info" : "warn"}">${src ? "ML-модель " + ml.version : "запасной режим: PD по скоркарте"}</span></div>
    <p class="muted small">Для каждого продукта PD считается для конкретного предложения (сумма, срок, обеспечение). ≤ порога «авто» — автоодобрение; ≥ порога «пропуск» — продукт пропускается; между ними серая зона: ${ml.grey_zone_policy === "refer" ? "сразу живому верификатору" : "сначала более безопасные продукты каскада, затем верификатор"}.</p>
    <div class="scroll"><table class="t"><thead><tr><th>Продукт</th><th class="right">PD</th><th>Грейд</th><th class="right">Пороги, %</th><th>Зона</th><th>Предложение</th></tr></thead><tbody>
    ${ml.trace.map((t) => h`<tr><td>${t.title}</td><td class="right num">${t.pd == null ? "—" : t.pd.toFixed(1) + " %"}</td>
      <td>${t.grade ? h`<span class="grade ${t.grade}">${t.grade}</span>` : "—"}</td>
      <td class="right num muted small">${ml.cutoffs[t.product].approve} / ${ml.cutoffs[t.product].decline}</td>
      <td><span class="chip ${ZONE[t.zone][0]}">${ZONE[t.zone][1]}</span></td>
      <td class="small">${t.amount ? h`${rub(t.amount)}, ${t.term} мес.${t.rate ? ", " + pct(t.rate) : ""}` : ""}${t.note ? h` <span class="muted">${t.note}</span>` : ""}</td></tr>`)}
    </tbody></table></div>
    ${ml.contributions.length ? h`<h3 class="mt">Что сильнее всего влияет на PD ${src ? "(вклады признаков, SHAP)" : ""}</h3>
      <div class="row wrapx">${ml.contributions.map((c) => h`<span class="chip ${c.value > 0 ? "warn" : "ok"}">${c.value > 0 ? "▲" : "▼"} ${FEAT[c.feature] || c.feature} ${c.value > 0 ? "+" : ""}${c.value}</span>`)}</div>
      <p class="hint">▲ повышает PD, ▼ снижает; значения в логитах.</p>` : ""}
    <p class="hint">Скоркарта-эталон для сравнения: PD ${ml.scorecard_pd} % (${dec.scorecard_score} баллов, грейд ${dec.scorecard_grade}).</p></div>`;
}

let bankSig = "";
async function viewBankApp(id, silent) {
  const d = await api("/bank/applications/" + id);
  const sig = d.status + d.version + d.events.length;
  if (silent && sig === bankSig && $("#bankview")) return;
  bankSig = sig; window.__bank = d;
  const dec = d.decision || {}, rec = dec.recommendation, af = dec.afford, req = d.request, ci = d.client_info;
  const reasonsOpts = Object.entries(d.reason_catalog);
  const src = d.enrichment ? Object.entries(d.enrichment) : [];
  const names = { egrul: "ЕГРЮЛ / ЕГРИП", fns: "ФНС «Прозрачный бизнес»", bureau: "Бюро кредитных историй", bank: "Внутренние данные банка" };
  render(h`${raw(topbar())}<main class="wrap" id="bankview"><a href="#/bank" class="small">← Очередь</a>
    <div class="row between wrapx mt mb"><div><h1>${d.id} · ${d.client}</h1><div class="muted">${d.product_title} · ${rub(d.amount)} на ${d.term} мес. · ${d.status_view.title}</div></div>${chip(d.status, d.status_title)}</div>
    <div class="cols"><div>
      <div class="card"><div class="row between wrapx head-ver"><h2>Скоринг и решение системы</h2>${dec.grade ? h`<span class="chip">версия карты ${dec.scorecard_version} · политика ${dec.policy_version}</span>` : ""}</div>
        ${dec.stops?.length ? h`<div class="notice bad mb"><b>Сработали стоп-правила:</b> ${dec.stops.map((x) => x.id + " — " + x.text).join("; ")}. Скоринг не рассчитывался.</div>` : ""}
        ${dec.score != null ? h`<div class="row wrapx mb" style="gap:24px"><div><div class="scorebig" data-count="1">${dec.score}</div><div class="muted small">баллов из 100</div></div>
          <div><span class="grade ${dec.grade}" style="width:40px;height:40px;font-size:20px;border-radius:12px">${dec.grade}</span><div class="muted small">грейд · PD ≈ ${dec.pd} %</div></div>
          <div><b>Решение системы:</b> ${{ approve: "одобрить как запрошено", counter: "встречное предложение", manual: "ручной разбор", decline: "отказ" }[dec.outcome]}
            ${dec.partial ? h`<div class="chip warn mt">Частичный скоринг: БКИ недоступно</div>` : ""}</div></div>
          ${dec.manual_reasons?.length ? h`<div class="notice warn mb"><b>Почему ручной разбор:</b> ${dec.manual_reasons.join("; ")}</div>` : ""}
          ${dec.flags?.length ? h`<div class="notice warn mb"><b>Мягкие флаги:</b> ${dec.flags.join("; ")}</div>` : ""}
          ${dec.ml ? h`<p class="muted small">Разбивка ниже — скоркарта-эталон (${dec.scorecard_score} баллов): запасной источник PD и основа пояснений.</p>` : ""}
          ${factorBars(dec.factors)}` : (dec.stops?.length ? "" : h`<p class="muted">Скоринг ещё не рассчитан.</p>`)}</div>
      ${dec.ml ? mlCard(dec) : ""}
      ${af ? h`<div class="card mt"><h2>Платёжеспособность: как посчитано</h2><dl class="kv"><dt>Чистый денежный поток (поступления × маржа отрасли)</dt><dd class="num">${rub(af.ncf)} / мес.</dd>
        <dt>Целевой DSCR для грейда ${dec.grade === "E" ? "D" : dec.grade}</dt><dd>${af.dscr_target}</dd><dt>Действующие платежи по кредитам</dt><dd class="num">${rub(af.existing)}</dd>
        <dt>Макс. платёж P_max = ЧДП / DSCR − текущие платежи</dt><dd class="num"><b>${rub(af.p_max)}</b></dd>
        ${af.amax_requested_term != null ? h`<dt>Макс. сумма на запрошенный срок</dt><dd class="num">${rub(af.amax_requested_term)}</dd>` : ""}
        ${af.limit_max != null ? h`<dt>Макс. лимит (50 % поступлений)</dt><dd class="num">${rub(af.limit_max)}</dd>` : ""}</dl>
        ${rec ? h`<hr><h3>Рекомендация системы</h3><p>${{ AS_REQUESTED: "Как запрошено", COUNTER: "Встречное предложение", DOWNSELL: "Другой продукт" }[rec.type] || "Предложение"}: <b>${rec.product_title || d.product_title}</b>, <b>${rub(rec.amount)}</b> на <b>${rec.term} мес.</b> под <b>${pct(rec.rate)}</b>${rec.payment ? h`, платёж ${rub(rec.payment)}` : ""}.</p>
          ${rec.type === "DOWNSELL" ? h`<div class="notice warn">Запрошен «${d.product_title}», рекомендован другой продукт: одобрение оформит предложение по продукту «${rec.product_title}».</div>` : ""}` : h`<p class="muted">Система не нашла условий, при которых заявка проходит.</p>`}</div>` : ""}
      <div class="card mt"><h2>Источники данных</h2>${src.length ? src.map(([k, v]) => h`<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>${names[k]}</span>
        <span><span class="chip ${v.status === "OK" ? "ok" : "bad"}">${v.status === "OK" ? "OK" : "недоступно"}</span> <span class="muted small">${dt(v.fetched_at)}</span></span></div>`)
        : h`<p class="muted">Данные ещё не запрашивались.</p>`}<p class="hint">Все источники — моки на синтетических данных; недоступность источника переводит заявку на ручной разбор, а не в отказ.</p></div>
      <div class="card mt"><h2>Клиент</h2><dl class="kv"><dt>Организация</dt><dd>${ci.name}</dd><dt>ИНН / ОГРН</dt><dd class="num">${ci.inn} / ${ci.ogrn}</dd><dt>ОКВЭД</dt><dd>${ci.okved}</dd>
        <dt>Руководитель</dt><dd>${ci.director}</dd><dt>Регистрация</dt><dd>${dateOnly(ci.registered)} · ${ci.tax_regime}</dd><dt>Запрос</dt><dd>${d.product_title}, ${rub(req.amount)}, ${req.term} мес.</dd>
        <dt>Цель</dt><dd>${req.purpose_text || req.purpose || "—"}</dd><dt>Согласия</dt><dd>${d.consents ? "ПДн, БКИ, ФНС — " + dt(d.consents.at) : "—"}</dd></dl></div>
    </div><div>
      ${d.can_decide ? h`<div class="card decide"><h2>Решение аналитика</h2>
        <div class="field"><label for="act">Действие</label><select id="act"><option value="approve">Одобрить / изменить условия</option><option value="request_docs">Запросить документы</option><option value="decline">Отказать</option></select></div>
        <div id="f-approve"><div class="grid g2"><div class="field"><label for="d_amt">Сумма, ₽</label><input id="d_amt" type="number" step="50000" value="${rec ? rec.amount : req.amount}"></div>
          <div class="field"><label for="d_trm">Срок, мес.</label><input id="d_trm" type="number" value="${rec ? rec.term : req.term}"></div></div>
          <p class="hint">Ставку система считает по формуле для ручного разбора; платёж выше P_max требует комментария. ${rec && rec.product && rec.product !== req.product ? h`Предложение оформится по продукту «${rec.product_title}».` : ""}</p></div>
        <div id="f-decline" class="hide"><label>Причины (видит клиент)</label>${reasonsOpts.map(([k, t]) => h`<label class="check"><input type="checkbox" class="rs" value="${k}"> <span><b>${k}</b> ${t}</span></label>`)}</div>
        <div class="field"><label for="d_cm">Комментарий</label><textarea id="d_cm" placeholder="Обязателен при запросе документов"></textarea></div>
        <button class="btn primary" data-act="decide">Принять решение</button></div>` : ""}
      <div class="card ${d.can_decide ? "mt" : ""}"><h2>Журнал событий</h2><ul class="timeline">${[...d.events].reverse().map((e, i) => h`<li class="${i === 0 ? "last" : ""}"><time>${dt(e.ts)} · ${e.actor}</time>
        <span class="${e.vis === "bank" ? "bankonly" : ""}">${e.message}</span>${e.from ? h` <span class="muted small">(${e.from} → ${e.to})</span>` : ""}</li>`)}</ul>
        <p class="hint">Синим — события, которые клиент не видит.</p></div>
    </div></div></main>`);
  syncDecisionForm(); animateCounts(root());
  if (!silent) { stopPoll(); poll = setInterval(() => viewBankApp(id, true).catch(() => {}), 3000); }
}
function syncDecisionForm() {
  const a = $("#act"); if (!a) return;
  $("#f-approve").classList.toggle("hide", a.value !== "approve");
  $("#f-decline").classList.toggle("hide", a.value !== "decline");
}

// ---------- роутер ----------
async function route(silent) {
  const hash = location.hash || "#/login";
  const [path, qs] = hash.slice(2).split("?");
  const parts = path.split("/"), params = new URLSearchParams(qs || "");
  try {
    if (parts[0] === "login" || !session.token) { if (parts[0] !== "login") location.hash = "#/login"; else await viewLogin(); return; }
    const role = session.user.role;
    if (parts[0] === "client") {
      if (role !== "client") return (location.hash = "#/bank");
      if (parts[1] === "new") { lastSig = ""; return await viewNew(params); }
      if (parts[1] === "app") return await viewApp(parts[2]);
      draft = null; lastSig = ""; return await viewClient(parts[1]);
    }
    if (parts[0] === "bank") {
      if (role === "client") return (location.hash = "#/client");
      if (parts[1] === "app") return await viewBankApp(parts[2], silent);
      return await viewBank();
    }
    location.hash = role === "client" ? "#/client" : "#/bank";
  } catch (e) { if (!silent) toast(e.message, true); }
}

// ---------- действия ----------
const act = {
  "logout": () => logout(),
  "demo-login": (el) => doLogin(el.dataset.login, "demo123"),
  "receipts-details": () => { if (window.__prof) showReceipts(window.__prof.receipts, receiptsMonth); },
  "loan-pick": (el) => { loanIdx = +el.dataset.i; repaintSection(); },
  "news-prev": () => { const t = $("[data-news]"); t?.scrollBy({ left: -(t.clientWidth - 40), behavior: "smooth" }); },
  "news-next": () => { const t = $("[data-news]"); t?.scrollBy({ left: t.clientWidth - 40, behavior: "smooth" }); },
  "radar-range": (el) => { radarRange = el.dataset.k; try { localStorage.setItem("radar-range", radarRange); } catch { /* приватный режим */ } const card = $(".card.radar"); if (card && window.__client) { card.outerHTML = radarCard(window.__client.forecast, window.__client.prod).s; $(".card.radar")?.classList.add("in"); } },
  "radar-scn": (el) => {
    radarScenario = el.dataset.v; if (!window.__client) return;
    const card = $(".card.radar"); if (card) { card.outerHTML = radarCard(window.__client.forecast, window.__client.prod).s; $(".card.radar")?.classList.add("in"); }
  },
  "prepay-amt": () => {},
  "notif": () => { const p = $("#notif-panel"); if (p) return p.remove(); document.body.insertAdjacentHTML("beforeend", notifPanel().s); try { localStorage.setItem("notif-seen", new Date().toISOString()); } catch { /* приватный режим */ } $(".bell .nbadge")?.remove(); },
  "notif-close": () => $("#notif-panel")?.remove(),
  "theme": () => applyTheme(themeNow() === "dark" ? "light" : "dark"),
  "notif-go": (el) => { $("#notif-panel")?.remove(); location.hash = el.getAttribute("href"); },
  "client-tab": (el, ev) => {
    if (!window.__client || !el.dataset.k || el.dataset.k === clientTab) { ev?.preventDefault?.(); return; }
    ev?.preventDefault?.(); clientTab = el.dataset.k;
    history.pushState(null, "", el.getAttribute("href")); lastHash = location.hash;
    $$(".client-tabs .ptab").forEach((b) => b.classList.toggle("sel", b === el));
    const box = $("#ctab"); box.classList.add("swap");
    setTimeout(() => { box.innerHTML = clientSection(clientTab, window.__client).s; box.dataset.tab = clientTab; animateCounts(box); initCarousels(); box.classList.remove("swap"); box.classList.add("in"); setTimeout(() => box.classList.remove("in"), 900); }, 260);
  },
  "feed-dismiss": (el) => {
    try { localStorage.setItem("feed:" + el.dataset.key, todayKey()); } catch { /* приватный режим */ }
    const card = el.closest(".fcard"), track = card?.parentElement; if (!card) return;
    card.classList.add("gone"); setTimeout(() => { card.remove(); if (track && !track.children.length) track.closest(".feed")?.remove(); else if (track) { const n = track.querySelectorAll(".fcard").length; const sub = track.closest(".feed")?.querySelector(".feed-head .muted"); if (sub) sub.textContent = (n ? plural(n, "уведомление", "уведомления", "уведомлений") + " · " : "") + "новости и сервисы банка · " + BANK_NEWS.length; } }, 450);
  },
  "role-tab": (el) => { $$(".ptab").forEach((b) => b.classList.toggle("sel", b === el)); $$(".role-group").forEach((g) => { g.hidden = g.dataset.group !== el.dataset.k; }); animateCounts(root()); },
  "scroll-roles": (el, e) => { e?.preventDefault?.(); document.getElementById("roles")?.scrollIntoView({ behavior: "smooth", block: "start" }); },
  "new-app": (el) => { draft = null; location.hash = "#/client/new" + (el.dataset.product ? "?product=" + el.dataset.product : ""); },
  "to-new": () => { draft = null; location.hash = "#/client/new"; },
  "purpose": (el) => { draft.purpose = el.dataset.id; draft.product = PURPOSES.find((x) => x.id === el.dataset.id).product; if (draft.product === "overdraft") { draft.term = 12; draft.amount = 500000; draft.collateral = "none"; } paintNew(); },
  "pick-product": (el) => { draft.product = el.dataset.id; const p = draft.cat.products.find((x) => x.id === draft.product);
    draft.amount = Math.min(Math.max(draft.amount, p.min_amount), p.max_amount); draft.term = Math.min(Math.max(draft.term, p.min_term), p.max_term);
    if (!p.collateral.includes(draft.collateral)) draft.collateral = p.collateral[0]; paintNew(); },
  "step": (el) => { draft.step = +el.dataset.to; paintNew(); },
  "submit-app": async (el) => {
    el.disabled = true;
    try {
      const p = draft.cat.products.find((x) => x.id === draft.product);
      const r = await api("/client/applications", { headers: { "Idempotency-Key": crypto.randomUUID?.() || String(Date.now()) },
        body: { product: draft.product, amount: draft.amount, term: p.kind === "limit" ? 12 : draft.term, collateral: draft.collateral, purpose: draft.purpose, purpose_text: draft.purpose_text, consents: draft.consents } });
      draft = null; location.hash = "#/client/app/" + r.id;
    } catch (e) { toast(e.message, true); el.disabled = false; }
  },
  "accept": () => call("/accept", "Предложение принято"),
  "decline-offer": (el) => askInline(el, "Отказаться от предложения? Заявка будет закрыта.", "Да, отказаться", () => call("/decline-offer", "Вы отказались от предложения", null, toHome)),
  "withdraw": (el) => askInline(el, "Отозвать заявку? Данные сохранятся, можно будет подать новую.", "Да, отозвать", () => call("/withdraw", "Заявка отозвана", null, toHome)),
  "docs": () => call("/documents", "Выписка подключена, проверяем повторно", { note: $("#note")?.value }),
  "sign": () => call("/sign", "Договор подписан", { code: $("#code")?.value || "" }),
  "csv": () => {
    const a = window.__app; const sm = (k) => a.schedule.reduce((t, r) => t + r[k], 0);
    const rows = ["№;Дата платежа;Основной долг;Проценты;Всего платёж;Остаток долга;Оплачен", ...a.schedule.map((r) => [r.n, r.date, r.principal, r.interest, r.payment, r.balance, r.paid ? "да" : ""].join(";")), ["Итого", "", sm("principal"), sm("interest"), sm("payment"), "", ""].join(";")];
    const url = URL.createObjectURL(new Blob(["﻿" + rows.join("\n")], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: `grafik-${a.id}.csv` }).click(); URL.revokeObjectURL(url);
  },
  "pay": async (el) => {
    el.disabled = true;
    const before = (window.__client?.prof.loans || []).find((x) => x.app_id === el.dataset.app) || window.__app?.loan;
    const paid = before?.next_payment?.amount;
    try { const r = await api(`/client/applications/${el.dataset.app}/pay`, { method: "POST" }); lastSig = ""; await route(); showPaid(r, paid ?? (r.loan ? r.loan.total_paid / Math.max(1, r.loan.paid_count) : 0)); } catch (e) { toast(e.message, true); el.disabled = false; }
  },
  "topup": async () => {
    try { await api("/client/account/topup", { body: { amount: +$("#topup").value } }); toast("Счёт пополнен (демо)"); lastSig = ""; await route(); } catch (e) { toast(e.message, true); }
  },
  "filter": (el) => { bankFilter = el.dataset.k; viewBank(); },
  "open-bank": (el) => { location.hash = "#/bank/app/" + el.dataset.id; },
  "save-settings": async () => {
    try { await api("/admin/settings", { body: { key_rate: +$("#kr").value, bureau_mode: $("#bm").value, step_delay: +$("#sd").value, decision_mode: $("#dm").value } }); toast("Настройки применены"); } catch (e) { toast(e.message, true); }
  },
  "reset": async () => { if (confirm("Удалить все заявки и вернуть настройки по умолчанию?")) { try { await api("/admin/reset", { method: "POST" }); toast("Демо-данные сброшены"); viewBank(); } catch (e) { toast(e.message, true); } } },
  "decide": async () => {
    const d = window.__bank, action = $("#act").value;
    const body = { action, comment: $("#d_cm").value, amount: +$("#d_amt")?.value || null, term: +$("#d_trm")?.value || null, reasons: [...document.querySelectorAll(".rs:checked")].map((x) => x.value) };
    try { await api(`/bank/applications/${d.id}/decision`, { body }); toast("Решение сохранено"); bankSig = ""; viewBankApp(d.id); } catch (e) { toast(e.message, true); }
  },
};
// подтверждение внутри страницы вместо window.confirm: встроенные браузеры и вебвью гасят нативные диалоги, и кнопка «не работает»
function askInline(btn, text, yesLabel, onYes) {
  if (!btn || btn.closest(".ask")) return;
  const box = document.createElement("span"); box.className = "ask";
  box.innerHTML = `<span class="ask-text">${esc(text)}</span><button class="btn sm danger" type="button">${esc(yesLabel)}</button><button class="btn sm" type="button">Нет</button>`;
  const [yes, no] = box.querySelectorAll("button");
  const restore = () => { box.replaceWith(btn); btn.focus(); };
  yes.addEventListener("click", (ev) => { ev.stopPropagation(); yes.disabled = true; onYes(); });
  no.addEventListener("click", (ev) => { ev.stopPropagation(); restore(); });
  box.addEventListener("keydown", (ev) => { if (ev.key === "Escape") restore(); });
  btn.replaceWith(box); yes.focus();
}

async function call(path, okMsg, body, after) {
  const id = window.__app.id;
  try { await api(`/client/applications/${id}${path}`, { method: "POST", body: body || undefined }); toast(okMsg); lastSig = ""; if (after) after(); else await viewApp(id); } catch (e) { toast(e.message, true); }
}
// после отзыва заявки или отказа от предложения — на главную кабинета, а не на страницу закрытой заявки
const toHome = () => { stopPoll(); clientTab = "overview"; location.hash = "#/client"; };

// подсказки терминов не должны выходить за края окна: сдвигаем по горизонтали при наведении или фокусе
function fitTip(e) {
  const el = e.target.closest && e.target.closest(".term");
  if (!el) return;
  const w = Math.min(280, innerWidth * 0.8), r = el.getBoundingClientRect(), ideal = r.left + r.width / 2 - w / 2;
  const clamped = Math.max(8, Math.min(ideal, innerWidth - w - 8));
  el.style.setProperty("--shift", Math.round(clamped - ideal) + "px");
}
document.addEventListener("mouseover", fitTip);
document.addEventListener("focusin", fitTip);

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (el && el.tagName !== "FORM" && act[el.dataset.act]) { e.preventDefault(); act[el.dataset.act](el, e); }
});
document.addEventListener("submit", (e) => {
  if (e.target.dataset.act === "login-form") { e.preventDefault(); doLogin($("#lg").value, $("#pw").value); }
});
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset.act === "prepay-amt") { prepayAmt[el.dataset.app] = +el.value; const box = el.closest(".card"); if (box) { const d = box.querySelector(".prepay"); const open = d?.open; const l = (window.__client?.prof.loans || []).find((x) => x.app_id === el.dataset.app); if (l && d) { d.outerHTML = prepayCalc(l).s; const nd = box.querySelector(".prepay"); if (nd) { nd.open = open; const f = nd.querySelector(el.type === "range" ? "input[type=range]" : "input[type=number]"); f?.focus(); } } } return; }
  if (el.dataset.bind && draft) {
    const k = el.dataset.bind;
    draft[k] = el.type === "number" || el.type === "range" ? +el.value : el.value;
    if (el.dataset.range) { const n = document.getElementById(el.dataset.range); if (n) n.value = el.value; }
    if (el.type === "number" && el.id) { const r = document.querySelector(`[data-range="${el.id}"]`); if (r) { r.value = el.value; paintRange(r); } }
    if (el.type === "range") paintRange(el);
    if (["amount", "term", "collateral"].includes(k)) refreshQuote();
  }
});
document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.dataset.bind === "collateral" && draft) { draft.collateral = el.value; refreshQuote(); }
  if (el.dataset.bindC && draft) { draft.consents[el.dataset.bindC] = el.checked; const b = $('[data-act="submit-app"]'); if (b) b.disabled = !(draft.consents.pd && draft.consents.bureau && draft.consents.fns); }
  if (el.id === "act") syncDecisionForm();
});
window.addEventListener("hashchange", () => { stopPoll(); root().classList.add("leaving"); clearTimeout(render._l); render._l = setTimeout(() => root().classList.remove("leaving"), 1500); route(); });
route();
})();
