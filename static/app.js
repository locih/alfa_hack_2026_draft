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
  "простая электронная подпись": "Подтверждение кодом, которое заменяет подпись от руки. В демо код показан на экране; в реальной системе он приходил бы в приложение банка.",
  "договор": "Документ с условиями кредита: сумма, срок, ставка, график платежей и права сторон.",
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
    ${raw(extra)}<span class="spacer"></span>
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
  const acc = (u) => h`<button class="rcard ${u.role === "client" ? "" : "bank"}" data-act="demo-login" data-login="${u.login}">
      <span class="av">${av(u.name)}</span><b>${u.name}</b><small>${u.hint}</small><span class="go">Войти ${arrow}</span></button>`;
  const clients = users.filter((u) => u.role === "client"), bank = users.filter((u) => u.role !== "client");
  render(h`<div class="landing">
    <header class="hero-dark"><div class="in">
      <div class="login-mark light"><i></i><span>Кредитный кабинет <small>· малый бизнес</small></span></div>
      <div class="hero-grid">
        <div class="hero-text">
          <h1>Кредит для бизнеса без лишних шагов</h1>
          <p class="lead">Подбор продукта по задаче, заявка за три минуты, живой статус и понятное решение. Для банка — та же заявка, скоринг по факторам и ручной разбор в одном окне.</p>
          <div class="tags"><span class="chip dark">Прототип · Альфа-Будущее Хакатон 2026</span><span class="chip dark">Данные синтетические</span><span class="chip dark">БКИ, ЕГРЮЛ, ФНС — моки</span></div>
          <a class="btn primary lg" href="#roles" data-act="scroll-roles">Выбрать роль и войти</a>
        </div>
        <div class="hero-art" aria-hidden="true"><img src="img/hero.webp" alt="" width="1200" height="900" decoding="async" onerror="this.remove()"></div>
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
    <div class="chart-head"><div class="chart-info"><span class="muted small">Наведите на столбик, чтобы увидеть месяц</span></div>
      <button class="btn sm" data-act="receipts-details">Детали поступлений</button></div>
    <svg class="chart" viewBox="0 0 ${W} ${H + 22}" role="img" aria-label="Поступления на счёт за 12 месяцев">
    ${receipts.map((v, i) => {
      const dt = monthOf(i), bh = Math.max(3, (v / max) * H), x = i * (bw + gap), prev = i ? receipts[i - 1] : null;
      return h`<g class="bar-g" tabindex="0" data-i="${i}" data-v="${v}" data-m="${monthName(dt)}" data-prev="${prev ?? ""}" data-avg="${Math.round(avg)}"><rect class="bar ${i < 6 ? "prev" : ""}" x="${x}" y="${H - bh}" width="${bw}" height="${bh}" rx="5"></rect>
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
const PAYERS = ["ООО «Ромашка»", "ИП Петров А. В.", "ООО «ТехноСнаб»", "АО «Логистика Плюс»", "ООО «Альфа-Трейд»", "ИП Сидорова М. К.", "ООО «СтройМастер»", "ООО «Вега Маркет»", "ИП Громов А. С.", "ООО «Северный ветер»"];
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
function showReceipts(receipts, month = 11) {
  receiptsMonth = month; document.getElementById("modal")?.remove();
  const ops = receiptsOps(month, receipts[month]), dt = monthOf(month);
  const el = document.createElement("div"); el.id = "modal"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Детали поступлений");
  el.innerHTML = h`<div class="modal-panel">
    <div class="modal-head"><div><h2>Поступления на счёт</h2><div class="muted small">Детализация по операциям · демо-данные, сформированы из месячных оборотов</div></div><button class="btn sm" data-act="modal-close" aria-label="Закрыть">✕</button></div>
    <div class="month-tabs">${receipts.map((v, i) => h`<button class="mtab ${i === month ? "sel" : ""}" data-act="receipts-month" data-i="${i}">${monthName(monthOf(i), false)}</button>`)}</div>
    <div class="row between wrapx mt"><div><div class="muted small">${monthName(dt)}</div><div class="big num">${rub(receipts[month])}</div></div><span class="chip">${ops.length} операций</span></div>
    <div class="scroll mt"><table class="t ops"><thead><tr><th>Дата</th><th>Плательщик</th><th>Назначение</th><th class="right">Сумма</th></tr></thead><tbody>
      ${ops.map((o) => h`<tr><td class="muted">${dateOnly(o.date)}</td><td><b>${o.payer}</b></td><td class="muted">${o.purpose}</td><td class="right num"><b>+${rub(o.amount)}</b></td></tr>`)}
    </tbody></table></div>
    <p class="hint">Реальная детализация придёт из выписки по счёту; в прототипе операции синтетические и повторяемые.</p></div>`.s;
  document.body.appendChild(el); document.body.classList.add("iss-open");
  const close = () => { el.classList.add("out"); document.body.classList.remove("iss-open"); setTimeout(() => el.remove(), 400); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  el.addEventListener("click", (e) => { if (e.target.closest("[data-act=modal-close]") || e.target === el) { close(); return; } const m = e.target.closest("[data-act=receipts-month]"); if (m) showReceipts(receipts, +m.dataset.i); });
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
      ${l.repaid ? "" : h`<button class="btn good" data-act="pay" data-app="${l.app_id}">Оплатить платёж №${np.n} — ${rub(np.amount)}</button>`}</div>
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

function feedBlock(prof, prod, active) {
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
      <div class="fbody"><div class="ftitle">${n < 0 ? "Платёж просрочен" : "Платёж"} ${rub(np.amount)} <span class="fwhen">· ${n < 0 ? whenText(n) : "до " + dateOnly(np.date) + ", " + whenText(n)}</span></div>
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
      <div class="fbody"><div class="ftitle">Нужно ваше действие</div><p class="ftext">${active.status.title}: ${active.status.text}</p>
      <div class="facts"><a class="btn primary" href="#/client/app/${active.id}">Открыть заявку</a></div></div></article>`);
  }
  // 3. Лучшее предодобренное предложение (когда нет активной заявки)
  if (!active) {
    const best = prof.preapproval.filter((p) => p.available && prod[p.product]?.eligible).sort((a, b) => b.max_amount - a.max_amount)[0];
    const key = best && `pre-${best.product}-${best.max_amount}`;
    if (best && !feedHidden(key)) cards.push(h`<article class="fcard" data-key="${key}" style="--i:${cards.length}">
      <span class="fico soft" aria-hidden="true">${PRODUCT_ICON[best.product]}</span>
      <button class="fx" data-act="feed-dismiss" data-key="${key}" aria-label="Скрыть до завтра">×</button>
      <div class="fbody"><div class="ftitle">Предодобрено до ${rub(best.max_amount)}</div>
      <p class="ftext">${prod[best.product].title} · ставка от ${pct(best.rate_from)} · по оборотам, которые банк уже видит. Без справок и визита.</p>
      <div class="facts"><button class="btn primary" data-act="new-app" data-product="${best.product}">Оформить</button></div></div></article>`);
    const pref = prof.preapproval.find((p) => p.product === "preferential" && p.available && prod.preferential?.eligible);
    if (pref && best?.product !== "preferential" && !feedHidden("pref")) cards.push(h`<article class="fcard ok" data-key="pref" style="--i:${cards.length}">
      <button class="fx" data-act="feed-dismiss" data-key="pref" aria-label="Скрыть до завтра">×</button>
      <div class="fbody"><div class="ftitle">Вам доступна льготная программа</div>
      <p class="ftext">Компания в реестре МСП приоритетной отрасли: ставка от ${pct(pref.rate_from)} до ${rub(pref.max_amount)}.</p>
      <div class="facts"><button class="btn" data-act="new-app" data-product="preferential">Посмотреть условия</button></div></div></article>`);
  }
  if (!cards.length) return "";
  return h`<section class="feed" aria-label="Для вас"><div class="feed-track">${cards}</div></section>`;
}

async function viewClient() {
  const [prof, apps, cat] = await Promise.all([api("/client/profile"), api("/client/applications"), api("/products")]);
  const prod = Object.fromEntries(cat.products.map((p) => [p.id, p]));
  const active = apps.find((a) => !a.status.terminal);
  const cn = prof.company;
  window.__prof = prof;
  stopPoll();
  render(h`${raw(topbar())}<main class="wrap">
    <div class="row between wrapx mb"><div><h1>${cn.name}</h1>
      <div class="muted">ИНН ${cn.inn} · ${cn.okved} · в банке ${prof.tenure_months} мес. · ${cn.tax_regime}</div></div>
      <span class="chip">Ключевая ставка ${pct(prof.key_rate)}</span></div>

    ${active ? h`<a class="card status ${active.status.turn} mb" href="#/client/app/${active.id}" style="display:block;color:inherit;text-decoration:none">
        <div class="row between wrapx"><div><span class="muted small">Активная заявка ${active.id} · ${active.product_title} · ${rub(active.amount)} на ${active.term} мес.</span>
        <h2 style="margin-top:4px">${active.status.title}</h2><p class="muted" style="margin:0">${active.status.text}</p></div>
        <span class="btn primary">${active.status.turn === "client" ? "Нужно ваше действие →" : "Открыть →"}</span></div></a>` : ""}

    ${feedBlock(prof, prod, active)}

    ${prof.loans.length ? h`<h2>Мои кредиты</h2><div class="grid g2 mb">${prof.loans.map((l) => h`<div class="card"><div class="row between wrapx"><div><b>${l.product_title}</b><br><span class="muted small">Договор ${l.contract} · ${pct(l.rate)}</span></div>
          <a class="small" href="#/client/app/${l.app_id}">График и детали →</a></div><div class="mt">${loanBlock(l, prof.account)}</div></div>`)}${accountCard(prof.account)}</div>` : ""}

    <h2>Предодобрено по данным, которые банк уже знает</h2>
    <p class="muted small">Предварительная оценка по вашим оборотам — не гарантия: итоговые условия назовёт банк после проверки заявки.</p>
    <div class="grid g4 mb">${prof.preapproval.map((p) => {
      const pr = prod[p.product];
      const head = h`<span class="pic lg" aria-hidden="true">${PRODUCT_ICON[p.product]}</span><h3>${pr.title}</h3>`;
      if (!pr.eligible) return h`<div class="card flat pcard">${head}<p class="muted small">Программа для МСП приоритетных отраслей — для вашей компании недоступна.</p></div>`;
      return h`<div class="card flat pcard">${head}
        ${p.available ? h`<div class="big num" data-count="${p.max_amount}" data-prefix="до ">до ${rub(p.max_amount)}</div><div class="muted small">ставка от ${pct(p.rate_from)}</div>
          <button class="btn primary" data-act="new-app" data-product="${p.product}" ${active ? "disabled" : ""}>Оформить</button>`
          : h`<p class="muted small">${p.message}</p><button class="btn" data-act="new-app" data-product="${p.product}" ${active ? "disabled" : ""}>Подать заявку</button>`}</div>`;
    })}</div>

    <div class="cols"><div class="card"><h2>Поступления на счёт за 12 месяцев</h2>
      ${turnoverChart(prof.receipts)}
      <div class="stat"><span>Среднее: <b class="num">${rub(prof.avg_receipts)}</b> / мес.</span>
      <span>Динамика (6 мес. к предыдущим 6): <b>${prof.dynamics >= 0 ? "+" : ""}${Math.round(prof.dynamics * 100)} %</b></span>
      <span>Платежи по кредитам: <b class="num">${rub(prof.existing_payments)}</b></span></div></div>
      <div class="card"><h2>Мои заявки</h2>
        ${apps.length ? apps.map((a) => h`<a href="#/client/app/${a.id}" class="approw">
          <span><b>${a.product_title}</b><br><span class="muted small">${a.id} · ${rub(a.amount)} · ${a.term} мес. · ${dateOnly(a.created)}</span></span>
          ${chip(a.status.code, a.status.title)}</a>`) : h`<p class="muted">Заявок пока нет. Выберите продукт выше — это займёт около 3 минут.</p>`}
        <button class="btn primary mt" data-act="new-app" ${active ? "disabled" : ""}>Новая заявка</button>
        ${active ? h`<p class="hint">Новую заявку можно подать после завершения текущей.</p>` : ""}</div></div></main>`);
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
        <h3><span class="pic sm" aria-hidden="true">${PRODUCT_ICON[x.id]}</span>${x.title} ${rec === x.id ? raw('<span class="chip accent">рекомендуем</span>') : ""} ${x.id === "preferential" && x.eligible ? raw('<span class="chip ok">вам доступно</span>') : ""}</h3>
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
    <div class="substeps mb" aria-label="Шаги заявки">${steps.map((s, i) => h`<span class="sub ${i + 1 < d.step ? "done" : i + 1 === d.step ? "now" : ""}"><i>${i + 1 < d.step ? "✓" : i + 1}</i>${s}</span>`)}</div>
    <div class="card ${d.step === 1 || d.step === 2 ? "calc" : ""}">${body}</div></main>`);
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
function showIssued(a) {
  const key = "issued-shown-" + a.id;
  try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, "1"); } catch { /* приватный режим */ }
  document.getElementById("issued-overlay")?.remove();
  const el = document.createElement("div"); el.id = "issued-overlay"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Кредит выдан");
  el.innerHTML = h`<div class="iss-glow"></div>
    <div class="iss-body">
      <svg class="iss-check" viewBox="0 0 120 120" aria-hidden="true"><circle class="iss-ring" cx="60" cy="60" r="54"/><path class="iss-tick" d="M34 62 L52 80 L88 42"/></svg>
      <h1>Кредит выдан!</h1>
      <p class="iss-sum">${rub(a.contract?.amount ?? a.offer?.amount ?? a.amount)} уже на вашем расчётном счёте</p>
      <p class="iss-sub">${a.contract?.first_payment ? h`Первый платёж ${rub(a.contract.first_payment.amount)} · ${dateOnly(a.contract.first_payment.date)}` : "График платежей и договор — в карточке кредита"}</p>
      <button class="btn primary" data-act="issued-close">Смотреть график платежей</button>
    </div>`.s;
  document.body.appendChild(el); document.body.classList.add("iss-open");
  const close = () => { el.classList.add("out"); document.body.classList.remove("iss-open"); setTimeout(() => el.remove(), 500); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  el.addEventListener("click", (e) => { if (e.target.closest("[data-act=issued-close]") || e.target === el) close(); });
  document.addEventListener("keydown", onKey);
  setTimeout(close, 12000);
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
  return h`<div class="card mt"><div class="row between wrapx"><h2>${down ? "Предлагаем другой продукт" : o.type === "AS_REQUESTED" ? "Одобрено на запрошенных условиях" : "Одобрено на других условиях"}</h2>
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
    ${a.status.code === "OFFER_READY" ? h`<div class="row wrapx mt"><button class="btn good" data-act="accept">Принять предложение</button>
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
  return h`<details class="mt" ${disb ? "open" : ""}><summary><b>${T("график платежей", "График платежей")}</b> <span class="muted small">· платежей: ${rows.length}${disb ? " · оплачено: " + rows.filter((r) => r.paid).length : ""}</span></summary>
    <div class="scroll mt"><table class="t sched"><thead><tr><th>№</th><th>Дата платежа</th><th class="right">${T("основной долг", "Основной долг")}, ₽</th><th class="right">${T("проценты", "Проценты")}, ₽</th><th class="right">Всего платёж, ₽</th><th class="right">${T("остаток долга", "Остаток долга")}, ₽</th>${disb ? h`<th class="center">Оплата</th>` : ""}</tr></thead><tbody>
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
      <div class="grid g3 mb">${[["договор", "Кредитный договор"], ["", "Согласие на обработку данных"], ["график платежей", "График платежей"]].map(([k, x]) => h`<div class="card flat small">📄 ${k ? T(k, x) : x}<br><span class="chip">готов</span></div>`)}</div>
      <div class="notice mb"><b>Вы подписываете:</b> ${a.offer.payment == null ? h`${T("лимит", "лимит")} ${rub(a.offer.amount)}` : h`кредит ${rub(a.offer.amount)} на ${a.offer.term} мес.`}, ${T("ставка", "ставка")} ${pct(a.offer.rate)}${a.offer.payment ? h`, ${T("платёж", "платёж")} ${rub(a.offer.payment)} в месяц, ${T("переплата", "переплата")} ${rub(a.offer.overpayment)}` : ""}; ${T("обеспечение", "обеспечение")}: ${a.collateral_label.toLowerCase()}. ${T("досрочное погашение", "Досрочное погашение")} без штрафа. Наведите курсор на подчёркнутое слово, чтобы увидеть пояснение.</div>
      <p>Подтвердите подписание кодом — это ${T("простая электронная подпись", "простая электронная подпись")} (имитация): в реальной системе код приходил бы в приложение банка.</p>
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
      <div class="card mt">${scheduleTable(a)}</div>${reasonsCard(a, "Почему такое решение")}`;
  } else if (code === "OFFER_READY" || code === "AWAITING_SIGNATURE") {
    ctx = h`${ctx}${scheduleTable(a)}`;
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
      <details class="card"><summary><b>История заявки</b> <span class="muted small">· последнее: ${tl[0].message}</span></summary><ul class="timeline mt">${tl.map((e, i) => h`<li class="${i === 0 ? "last" : ""}"><time>${dt(e.ts)}</time>${e.message}</li>`)}</ul></details></div></main>`);
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
      <div class="card"><div class="row between wrapx"><h2>Скоринг и решение системы</h2>${dec.grade ? h`<span class="chip">версия карты ${dec.scorecard_version} · политика ${dec.policy_version}</span>` : ""}</div>
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
      draft = null; lastSig = ""; return await viewClient();
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
  "feed-dismiss": (el) => {
    try { localStorage.setItem("feed:" + el.dataset.key, todayKey()); } catch { /* приватный режим */ }
    const card = el.closest(".fcard"), track = card?.parentElement; if (!card) return;
    card.classList.add("gone"); setTimeout(() => { card.remove(); if (track && !track.children.length) track.closest(".feed")?.remove(); }, 450);
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
  "decline-offer": () => confirm("Отказаться от предложения? Заявка будет закрыта.") && call("/decline-offer", "Вы отказались от предложения"),
  "withdraw": () => confirm("Отозвать заявку?") && call("/withdraw", "Заявка отозвана"),
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
    try { await api(`/client/applications/${el.dataset.app}/pay`, { method: "POST" }); toast("Платёж оплачен"); lastSig = ""; await route(); } catch (e) { toast(e.message, true); el.disabled = false; }
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
async function call(path, okMsg, body) {
  const id = window.__app.id;
  try { await api(`/client/applications/${id}${path}`, { method: "POST", body: body || undefined }); toast(okMsg); lastSig = ""; await viewApp(id); } catch (e) { toast(e.message, true); }
}

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
