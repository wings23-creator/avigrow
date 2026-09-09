import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6";

// Hebrew strings below are written as literal Hebrew - when copying this file into
// the Supabase dashboard editor, always start from a FULLY EMPTY editor buffer and
// paste an ASCII-escaped (\uXXXX) version, otherwise partial-selection pastes can
// silently leave stale text at the top of the file.
//
// The reminder covers three care tasks, not just watering: watering, fertilizing
// and a substrate change. Each one works the same way - an interval in days plus
// the date it was last done - so they share all of the logic below.

type Lang = "he" | "en" | "ru";

const COPY: Record<Lang, {
  dir: string;
  subject: string;
  h2: string;
  intro: string;
  footer: string;
  copyright: string;
  never: string;
  overdue: (n: number) => string;
  task: { water: string; fertilize: string; repot: string };
}> = {
  he: {
    dir: "rtl",
    subject: "תזכורת טיפול בצמחים - AviGrow",
    h2: "תזכורת טיפול",
    intro: "הצמחים האלה מחכים לטיפול היום:",
    footer: "אפשר לסמן שביצעתם באתר AviGrow, וכך התזכורת הבאה תתוזמן מחדש.",
    copyright: "© 2026 יעל רוזן. כל הזכויות שמורות.",
    never: "עוד לא בוצע",
    overdue: (n) => "באיחור " + n + " " + (n === 1 ? "יום" : "ימים"),
    task: { water: "השקיה", fertilize: "דישון", repot: "החלפת מצע" }
  },
  en: {
    dir: "ltr",
    subject: "Plant care reminder - AviGrow",
    h2: "Care reminder",
    intro: "These plants are waiting for care today:",
    footer: "Mark them as done in AviGrow and the next reminder reschedules itself.",
    copyright: "© 2026 Yael Rosen. All rights reserved.",
    never: "not done yet",
    overdue: (n) => n + " " + (n === 1 ? "day" : "days") + " overdue",
    task: { water: "Watering", fertilize: "Fertilizing", repot: "Substrate change" }
  },
  ru: {
    dir: "ltr",
    subject: "Напоминание об уходе за растениями - AviGrow",
    h2: "Напоминание об уходе",
    intro: "Этим растениям сегодня нужен уход:",
    footer: "Отметьте выполнение в AviGrow, и следующее напоминание сдвинется само.",
    copyright: "© 2026 Яэль Розен. Все права защищены.",
    never: "ещё не выполнено",
    overdue: (n) => {
      const t1 = n % 10, t2 = n % 100;
      const word = (t1 === 1 && t2 !== 11) ? "день"
        : (t1 >= 2 && t1 <= 4 && (t2 < 10 || t2 >= 20)) ? "дня" : "дней";
      return "просрочено на " + n + " " + word;
    },
    task: { water: "Полив", fertilize: "Подкормка", repot: "Смена субстрата" }
  }
};

type TaskKey = "water" | "fertilize" | "repot";

const TASK_FIELDS: Record<TaskKey, { interval: string; last: string; seasonal: boolean }> = {
  water:     { interval: "watering_interval_days",  last: "last_watered_at",    seasonal: false },
  fertilize: { interval: "fertilize_interval_days", last: "last_fertilized_at", seasonal: true },
  repot:     { interval: "repot_interval_days",     last: "last_repotted_at",   seasonal: false }
};

// Feeding a dormant plant burns roots that are not taking anything up, so a
// fertilizing reminder is suppressed outside the plant's own growing season.
// Summer growers rest Dec-Feb; winter growers (lithops, winter caudex) rest Jun-Aug.
function isFeedingSeason(growthSeason: string | null): boolean {
  const m = new Date().getMonth() + 1;
  const gs = growthSeason || "summer";
  if (gs === "year_round") return true;
  if (gs === "winter") return !(m >= 6 && m <= 8);
  return !(m === 12 || m <= 2);
}

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  const provided = req.headers.get("x-cron-secret");
  if (cronSecret && provided !== cronSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  const today = new Date().toISOString().slice(0, 10);

  const { data: plants, error } = await supabase
    .from("plants")
    .select("id, name_he, user_id, watering_interval_days, last_watered_at, fertilize_interval_days, last_fertilized_at, repot_interval_days, last_repotted_at, growth_season, last_watering_reminder_at, photo_base64")
    .eq("source", "mine")
    // only plants that actually have a schedule - the rows carry base64 photos,
    // so pulling every plant would bloat the response for nothing
    .or("watering_interval_days.not.is.null,fertilize_interval_days.not.is.null,repot_interval_days.not.is.null");

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const msPerDay = 24 * 60 * 60 * 1000;
  const now = Date.now();

  type DueTask = { key: TaskKey; overdueDays: number | null };
  type DuePlant = { id: number; name: string; photo: string | null; tasks: DueTask[] };
  const dueByUser: Record<string, DuePlant[]> = {};
  const idsToMark: number[] = [];

  for (const p of plants || []) {
    if (p.last_watering_reminder_at === today) continue;

    const tasks: DueTask[] = [];
    for (const key of ["water", "fertilize", "repot"] as TaskKey[]) {
      const fields = TASK_FIELDS[key];
      const interval = (p as Record<string, unknown>)[fields.interval] as number | null;
      if (!interval) continue;
      if (fields.seasonal && !isFeedingSeason(p.growth_season)) continue;

      const last = (p as Record<string, unknown>)[fields.last] as string | null;
      if (!last) {
        tasks.push({ key, overdueDays: null });
        continue;
      }
      const daysSince = Math.floor((now - new Date(last).getTime()) / msPerDay);
      const daysLeft = interval - daysSince;
      if (daysLeft <= 0) tasks.push({ key, overdueDays: -daysLeft });
    }

    if (tasks.length === 0) continue;
    dueByUser[p.user_id] = dueByUser[p.user_id] || [];
    dueByUser[p.user_id].push({ id: p.id, name: p.name_he, photo: p.photo_base64 || null, tasks });
    idsToMark.push(p.id);
  }

  let userIds = Object.keys(dueByUser);
  if (userIds.length === 0) {
    return new Response(JSON.stringify({ sent: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  // The chosen site language lives on the profile, so the email can be written
  // in the same language the person actually uses the app in.
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, notify_watering, lang")
    .in("id", userIds);
  const optedOut = new Set((profiles || []).filter((p) => p.notify_watering === false).map((p) => p.id));
  const langById: Record<string, Lang> = {};
  for (const p of profiles || []) {
    langById[p.id] = (p.lang === "en" || p.lang === "ru") ? p.lang : "he";
  }
  userIds = userIds.filter((id) => !optedOut.has(id));

  if (idsToMark.length > 0) {
    await supabase.from("plants").update({ last_watering_reminder_at: today }).in("id", idsToMark);
  }

  if (userIds.length === 0) {
    return new Response(JSON.stringify({ sent: 0, skippedOptOut: true }), {
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

  // Gmail strips inline data: image URIs, so each photo is sent as a real
  // attachment and referenced from the HTML by its cid.
  function photoToAttachment(dataUrl: string, cid: string) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(dataUrl);
    if (!match) return null;
    return {
      filename: cid + ".jpg",
      content: match[2],
      encoding: "base64" as const,
      cid,
      contentType: match[1]
    };
  }

  let sentCount = 0;
  for (const userId of userIds) {
    const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(userId);
    if (userErr || !userData?.user?.email) continue;
    const email = userData.user.email;
    const copy = COPY[langById[userId] || "he"];
    const plantsForUser = dueByUser[userId];

    const taskText = (t: DueTask) =>
      copy.task[t.key] + ": " + (t.overdueDays === null ? copy.never : copy.overdue(t.overdueDays));

    const attachments: { filename: string; content: string; encoding: "base64"; cid: string; contentType: string }[] = [];
    const htmlList = plantsForUser
      .map((p, idx) => {
        let imgTag = "";
        if (p.photo) {
          const cid = `plant${idx}`;
          const att = photoToAttachment(p.photo, cid);
          if (att) {
            attachments.push(att);
            imgTag = `<img src="cid:${cid}" alt="${p.name}" style="width:80px;height:80px;object-fit:cover;border-radius:8px;vertical-align:middle;margin-inline-end:10px;">`;
          }
        }
        const lines = p.tasks.map(taskText).join("<br>");
        return `<li style="margin-bottom:10px;list-style:none;display:flex;align-items:center;">${imgTag}<span><strong>${p.name}</strong><br><span style="color:#777;font-size:0.85em;">${lines}</span></span></li>`;
      })
      .join("");

    const textList = plantsForUser
      .map((p) => `- ${p.name} (${p.tasks.map(taskText).join("; ")})`)
      .join("\n");

    try {
      await transporter.sendMail({
        from: `"AviGrow" <${gmailUser}>`,
        to: email,
        subject: copy.subject,
        text: `${copy.intro}\n\n${textList}\n\n${copy.footer}`,
        html: `<div dir="${copy.dir}" style="font-family:sans-serif;">
          <h2>${copy.h2} \u{1F331}</h2>
          <p>${copy.intro}</p>
          <ul style="padding:0;">${htmlList}</ul>
          <p>${copy.footer}</p>
          <hr style="border:none;border-top:1px solid #ddd;margin:20px 0 10px;">
          <p style="color:#999;font-size:0.75em;text-align:center;">${copy.copyright}</p>
        </div>`,
        attachments
      });
      sentCount++;
    } catch (e) {
      console.error("Failed to send to", email, e);
    }
  }

  return new Response(JSON.stringify({ sent: sentCount, usersNotified: userIds.length }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});
