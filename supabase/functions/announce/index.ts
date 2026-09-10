import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6";

// One-off announcement mailer: tells every registered user, in the language they
// use the app in, that a new version is out.
//
// Hebrew/Russian strings below are literal - when pasting this into the Supabase
// dashboard editor, start from a FULLY EMPTY buffer and paste an ASCII-escaped
// (\uXXXX) build of it, otherwise the editor mangles them.
//
// ANNOUNCEMENT_KEY is the double-send guard: every user who is mailed gets the
// key written to profiles.last_announcement, and anyone already carrying it is
// skipped. Re-running the workflow therefore mails nobody twice. Bump the key
// for the next announcement.
const ANNOUNCEMENT_KEY = "2026-09-care-tasks";

const APP_URL = "https://wings23-creator.github.io/avigrow/";

type Lang = "he" | "en" | "ru";

const COPY: Record<Lang, {
  dir: string;
  subject: string;
  hello: (name: string) => string;
  intro: string;
  items: string[];
  cta: string;
  footer: string;
  copyright: string;
}> = {
  he: {
    dir: "rtl",
    subject: "יש גרסה חדשה ב-AviGrow 🌱",
    hello: (name) => name ? "היי " + name + "," : "היי,",
    intro: "עדכנו את AviGrow, וכמה דברים חדשים מחכים לך:",
    items: [
      "<b>תנאי גידול לכל צמח</b> - תאורה, עונתיות, מצע והשקיה, מותאמים למין הספציפי שלו.",
      "<b>תזכורות גם לדישון ולהחלפת מצע</b>, לא רק להשקיה - ורק לצמחים שבאמת צריכים אותן.",
      "<b>הכל בשפה שלך</b> - האתר והמיילים בעברית, אנגלית או רוסית, לפי בחירתך.",
      "<b>רשימה נוחה יותר במחשב</b> - שורה אחת לכל צמח, שנפתחת ללחיצה כדי לעדכן."
    ],
    cta: "לכניסה לאפליקציה",
    footer: "אפשר לכבות תזכורות במייל בכל רגע, דרך \"עדכון פרטים\" באפליקציה.",
    copyright: "© 2026 יעל רוזן. כל הזכויות שמורות."
  },
  en: {
    dir: "ltr",
    subject: "A new version of AviGrow is here 🌱",
    hello: (name) => name ? "Hi " + name + "," : "Hi,",
    intro: "AviGrow has been updated, and a few new things are waiting for you:",
    items: [
      "<b>Growing conditions for every plant</b> - light, seasonality, substrate and watering, matched to its species.",
      "<b>Reminders for fertilizing and substrate changes too</b>, not just watering - and only for the plants that actually need them.",
      "<b>Everything in your language</b> - the site and the emails in Hebrew, English or Russian, whichever you pick.",
      "<b>An easier list on a computer</b> - one row per plant, which opens up when you click it."
    ],
    cta: "Open the app",
    footer: "You can turn email reminders off at any time under \"Account settings\" in the app.",
    copyright: "© 2026 Yael Rosen. All rights reserved."
  },
  ru: {
    dir: "ltr",
    subject: "Вышла новая версия AviGrow 🌱",
    hello: (name) => name ? "Привет, " + name + "!" : "Здравствуйте!",
    intro: "Мы обновили AviGrow, и вас ждёт несколько новых возможностей:",
    items: [
      "<b>Условия выращивания для каждого растения</b> - освещение, сезонность, субстрат и полив, с учётом конкретного вида.",
      "<b>Напоминания о подкормке и смене субстрата</b>, а не только о поливе - и только для тех растений, которым это действительно нужно.",
      "<b>Всё на вашем языке</b> - сайт и письма на иврите, английском или русском, по вашему выбору.",
      "<b>Удобный список на компьютере</b> - одна строка на растение, раскрывается по клику."
    ],
    cta: "Открыть приложение",
    footer: "Отключить письма можно в любой момент в разделе \"Настройки аккаунта\".",
    copyright: "© 2026 Яэль Розен. Все права защищены."
  }
};

Deno.serve(async (req) => {
  // Fail closed: unlike the reminder function, a missing secret must NOT make
  // this endpoint public - anyone hitting it would mail every user at once.
  const cronSecret = Deno.env.get("CRON_SECRET");
  const provided = req.headers.get("x-cron-secret");
  if (!cronSecret || provided !== cronSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  // ?dry=1 reports exactly who would be mailed, and sends nothing.
  const dryRun = new URL(req.url).searchParams.get("dry") === "1";

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, email, first_name, lang, notify_watering, last_announcement");

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const recipients = (profiles || []).filter((p) =>
    p.email &&
    p.notify_watering !== false &&          // respect the email opt-out
    p.last_announcement !== ANNOUNCEMENT_KEY // and never send the same one twice
  );

  const byLang: Record<string, number> = {};
  for (const p of recipients) {
    const l = (p.lang === "en" || p.lang === "ru") ? p.lang : "he";
    byLang[l] = (byLang[l] || 0) + 1;
  }

  if (dryRun) {
    return new Response(JSON.stringify({
      dryRun: true,
      key: ANNOUNCEMENT_KEY,
      totalProfiles: (profiles || []).length,
      wouldSend: recipients.length,
      byLang
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (recipients.length === 0) {
    return new Response(JSON.stringify({ sent: 0, reason: "nobody left to notify" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const gmailUser = Deno.env.get("GMAIL_USER")!;
  const gmailPassword = Deno.env.get("GMAIL_APP_PASSWORD")!;
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: gmailUser, pass: gmailPassword }
  });

  let sentCount = 0;
  const failed: string[] = [];

  for (const p of recipients) {
    const lang: Lang = (p.lang === "en" || p.lang === "ru") ? p.lang : "he";
    const copy = COPY[lang];
    const name = (p.first_name || "").trim();

    const listHtml = copy.items.map((i) => `<li style="margin-bottom:10px;">${i}</li>`).join("");
    const listText = copy.items.map((i) => "- " + i.replace(/<\/?b>/g, "")).join("\n");

    try {
      await transporter.sendMail({
        from: `"AviGrow" <${gmailUser}>`,
        to: p.email,
        subject: copy.subject,
        text: `${copy.hello(name)}\n\n${copy.intro}\n\n${listText}\n\n${copy.cta}: ${APP_URL}\n\n${copy.footer}`,
        html: `<div dir="${copy.dir}" style="font-family:sans-serif;max-width:560px;">
          <h2>${copy.subject}</h2>
          <p>${copy.hello(name)}</p>
          <p>${copy.intro}</p>
          <ul style="padding-inline-start:20px;">${listHtml}</ul>
          <p style="margin:24px 0;">
            <a href="${APP_URL}" style="background:#7A9A1E;color:#fff;text-decoration:none;padding:10px 22px;border-radius:999px;display:inline-block;">${copy.cta}</a>
          </p>
          <p style="color:#777;font-size:0.85em;">${copy.footer}</p>
          <hr style="border:none;border-top:1px solid #ddd;margin:20px 0 10px;">
          <p style="color:#999;font-size:0.75em;text-align:center;">${copy.copyright}</p>
        </div>`
      });
      // Mark per user immediately, so a crash halfway through cannot cause a
      // second run to re-mail the people who already got it.
      await supabase.from("profiles").update({ last_announcement: ANNOUNCEMENT_KEY }).eq("id", p.id);
      sentCount++;
    } catch (e) {
      console.error("Failed to send to", p.email, e);
      failed.push(p.email);
    }
  }

  // Every send failing means the mailer is down (a stale GMAIL_APP_PASSWORD
  // returns 535 for each recipient), so answer 5xx and let the workflow go red
  // instead of reporting a green "success" that delivered nothing.
  const allFailed = sentCount === 0 && failed.length > 0;
  return new Response(JSON.stringify({
    sent: sentCount,
    failed: failed.length,
    key: ANNOUNCEMENT_KEY,
    byLang,
    ...(allFailed ? { error: "every send failed - check GMAIL_APP_PASSWORD" } : {})
  }), {
    status: allFailed ? 500 : 200,
    headers: { "Content-Type": "application/json" }
  });
});
