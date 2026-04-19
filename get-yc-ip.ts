import fs from "fs";

const YC_API_BASE = "https://vpc.api.cloud.yandex.net/vpc/v1";

/* ================= CONFIG & STATE ================= */

let config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));

// Инициализация полей
if (!config.targetSubnets) config.targetSubnets = ["51.250."];
if (!config.allowedUsers) config.allowedUsers = [];

function saveConfig() {
  fs.writeFileSync("./config.json", JSON.stringify(config, null, 2));
}

type Account = {
  id: string;
  name: string;
  iamToken: string;
  folderId: string;
  enabled: boolean;
  scanned: number;
  found: number;
  deleted?: boolean;
};

let ACCOUNTS: Account[] = [];
try {
  ACCOUNTS = JSON.parse(fs.readFileSync("./accounts.json", "utf-8"));
  ACCOUNTS.forEach(a => { 
    a.enabled = false; 
    a.scanned = a.scanned || 0; 
    a.found = a.found || 0; 
  });
} catch (e) {
  ACCOUNTS = [];
}

function saveAccounts() {
  fs.writeFileSync("./accounts.json", JSON.stringify(ACCOUNTS, null, 2));
}

/* ================= BOT STATE MACHINE ================= */

type UserState = {
  step: "IDLE" | "AWAIT_ACC_NAME" | "AWAIT_ACC_TOKEN" | "AWAIT_ACC_FOLDER" | "AWAIT_SUBNETS" | "AWAIT_EMPLOYEE_ID";
  tempData: Partial<Account>;
};

let chatState: UserState = {
  step: "IDLE",
  tempData: {}
};

/* ================= HELPERS ================= */

// Проверка: является ли пользователь главным админом
const isAdmin = (id: number | string) => String(id) === String(config.telegramChatId);

// Проверка: есть ли у пользователя доступ (админ или сотрудник)
const isAllowed = (id: number | string) => isAdmin(id) || config.allowedUsers.includes(String(id));

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function isTargetIp(ip: string) {
  return config.targetSubnets.some((subnet: string) => ip.startsWith(subnet));
}

function getAccount(id: string) {
  return ACCOUNTS.find(a => a.id === id);
}

/* ================= TELEGRAM API ================= */

async function tgRequest(method: string, body: any = {}) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    console.error(`TG API Error (${method}):`, e);
  }
}

async function tgSend(chatId: string | number, text: string, markup?: any) {
  return await tgRequest("sendMessage", { chat_id: chatId, text, reply_markup: markup, parse_mode: "HTML" });
}

async function tgEdit(chatId: string | number, message_id: number, text: string, markup?: any) {
  await tgRequest("editMessageText", {
    chat_id: chatId,
    message_id,
    text,
    reply_markup: markup,
    parse_mode: "HTML"
  });
}

async function tgAnswerCb(callback_query_id: string, text?: string, show_alert = false) {
  await tgRequest("answerCallbackQuery", { callback_query_id, text, show_alert });
}

// Рассылка всем авторизованным пользователям
async function broadcast(text: string) {
  const targets = Array.from(new Set([String(config.telegramChatId), ...config.allowedUsers]));
  for (const id of targets) {
    await tgSend(id, text);
  }
}

/* ================= UI MENUS ================= */

const Menus = {
  main: () => ({
    text: "💻 <b>Главное меню</b>",
    markup: {
      inline_keyboard: [
        [{ text: "➕ Добавить аккаунт", callback_data: "add_account" }],
        [{ text: "ℹ️ Аккаунты", callback_data: "nav_accounts" }],
        [{ text: "⚙️ Настройки", callback_data: "nav_settings" }]
      ]
    }
  }),

  accounts: () => ({
    text: "ℹ️ <b>Ваши аккаунты</b>\nВыберите аккаунт для управления:",
    markup: {
      inline_keyboard: [
        ...ACCOUNTS.map(a => ([{ text: `${a.enabled ? "🟢" : "🔴"} ${a.name}`, callback_data: `acc_${a.id}` }])),
        [{ text: "🔙 Назад", callback_data: "nav_main" }]
      ]
    }
  }),

  accountView: (acc: Account) => ({
    text: `💻 <b>Аккаунт:</b> ${acc.name}\n\n` +
          `📊 <b>Пролистано:</b> ${acc.scanned}\n` +
          `🎯 <b>Поймано:</b> ${acc.found}\n\n` +
          `Статус: ${acc.enabled ? "🟢 Работает" : "🔴 Выключен"}`,
    markup: {
      inline_keyboard: [
        [{ text: acc.enabled ? "🔴 Выключить" : "🟢 Включить", callback_data: `toggle_${acc.id}` }],
        [{ text: "🗑 Удалить аккаунт", callback_data: `del_${acc.id}` }],
        [{ text: "🔙 Назад", callback_data: "nav_accounts" }]
      ]
    }
  }),

  settings: (userId: number | string) => {
    const kb = [[{ text: "🔨 Настроить подсети", callback_data: "set_subnets" }]];
    
    // Кнопка сотрудников видна только админу
    if (isAdmin(userId)) {
      kb.push([{ text: "👥 Управление сотрудниками", callback_data: "manage_employees" }]);
    }
    
    kb.push([{ text: "🔙 Назад", callback_data: "nav_main" }]);
    
    return {
      text: `⚙️ <b>Настройки</b>\n\nТекущие подсети: <code>${config.targetSubnets.join(" ")}</code>`,
      markup: { inline_keyboard: kb }
    };
  },

  employees: () => ({
    text: "👥 <b>Список сотрудников</b>\n\n" + 
          (config.allowedUsers.length > 0 
            ? config.allowedUsers.map((id: string) => `• <code>${id}</code>`).join("\n") 
            : "Список сотрудников пуст"),
    markup: {
      inline_keyboard: [
        [{ text: "➕ Добавить сотрудника", callback_data: "add_employee" }],
        [{ text: "🗑 Очистить список", callback_data: "clear_employees" }],
        [{ text: "🔙 Назад", callback_data: "nav_settings" }]
      ]
    }
  }),

  backBtn: (target: string) => ({
    inline_keyboard: [[{ text: "🔙 Отмена", callback_data: target }]]
  })
};

/* ================= BOT LOGIC ================= */

let offset = 0;

async function botLoop() {
  await tgRequest("setMyCommands", { commands: [{ command: "start", description: "Перезапустить бота" }] });
  console.log("Бот запущен и ожидает команд...");

  while (true) {
    try {
      const data = await tgRequest("getUpdates", { offset, timeout: 50 });

      for (const upd of data.result || []) {
        offset = upd.update_id + 1;
        const chatId = upd.message?.chat?.id || upd.callback_query?.message?.chat?.id;
        if (!chatId) continue;

        // ПРОВЕРКА ДОСТУПА
        if (!isAllowed(chatId)) {
          if (upd.message) await tgSend(chatId, "❌ Бот недоступен для вас");
          continue;
        }

        const msg = upd.message?.text;
        const cb = upd.callback_query?.data;
        const cbId = upd.callback_query?.id;
        const cbMsgId = upd.callback_query?.message?.message_id;

        /* ===== ТЕКСТОВЫЕ КОМАНДЫ ===== */
        if (msg) {
          if (msg === "/start") {
            chatState.step = "IDLE";
            await tgSend(chatId, Menus.main().text, Menus.main().markup);
          } 
          else if (chatState.step === "AWAIT_ACC_NAME") {
            // ПРОВЕРКА НА СУЩЕСТВУЮЩЕЕ ИМЯ
            const exists = ACCOUNTS.some(a => a.name.toLowerCase() === msg.toLowerCase());
            if (exists) {
                await tgSend(chatId, `❌ Аккаунт с именем <b>${msg}</b> уже есть в базе. Введите другое название:`, Menus.backBtn("nav_main"));
                continue; 
            }

            chatState.tempData.name = msg; chatState.step = "AWAIT_ACC_TOKEN";
            await tgSend(chatId, `Введите IAM или OAuth токен для <b>${msg}</b>:`, Menus.backBtn("nav_main"));
          } 
          else if (chatState.step === "AWAIT_ACC_TOKEN") {
            chatState.tempData.iamToken = msg; chatState.step = "AWAIT_ACC_FOLDER";
            await tgSend(chatId, "Введите Folder ID (каталога):", Menus.backBtn("nav_main"));
          } 
          else if (chatState.step === "AWAIT_ACC_FOLDER") {
            const newAcc: Account = { 
                id: Date.now().toString(), 
                name: chatState.tempData.name!, 
                iamToken: chatState.tempData.iamToken!, 
                folderId: msg, 
                enabled: false, 
                scanned: 0, 
                found: 0 
            };
            ACCOUNTS.push(newAcc); 
            saveAccounts(); 
            worker(newAcc);
            chatState.step = "IDLE"; 
            await tgSend(chatId, `➕ Аккаунт <b>${newAcc.name}</b> успешно добавлен`, Menus.main().markup);
          }
          else if (chatState.step === "AWAIT_SUBNETS") {
            const subnets = msg.split(" ").filter(Boolean);
            if (subnets.length > 0) {
              config.targetSubnets = subnets;
              saveConfig();
              chatState.step = "IDLE";
              await tgSend(chatId, "✅ Подсети обновлены", Menus.main().markup);
            }
          }
          else if (chatState.step === "AWAIT_EMPLOYEE_ID" && isAdmin(chatId)) {
            const newId = msg.trim();
            if (newId && !config.allowedUsers.includes(newId)) {
              config.allowedUsers.push(newId);
              saveConfig();
              await tgSend(chatId, `✅ Сотрудник <code>${newId}</code> добавлен в список`, Menus.employees().markup);
            } else {
              await tgSend(chatId, "Этот ID уже в списке или введен неверно", Menus.employees().markup);
            }
            chatState.step = "IDLE";
          }
        }

        /* ===== ОБРАБОТКА КНОПОК ===== */
        if (cb && cbMsgId) {
          if (cb === "nav_main") {
            chatState.step = "IDLE";
            await tgEdit(chatId, cbMsgId, Menus.main().text, Menus.main().markup);
          }
          else if (cb === "nav_accounts") {
            await tgEdit(chatId, cbMsgId, Menus.accounts().text, Menus.accounts().markup);
          }
          else if (cb === "nav_settings") {
            await tgEdit(chatId, cbMsgId, Menus.settings(chatId).text, Menus.settings(chatId).markup);
          }
          else if (cb === "add_account") {
            chatState.step = "AWAIT_ACC_NAME";
            await tgEdit(chatId, cbMsgId, "Введите имя аккаунта:", Menus.backBtn("nav_main"));
          }
          else if (cb === "set_subnets") {
            chatState.step = "AWAIT_SUBNETS";
            await tgEdit(chatId, cbMsgId, "🔨 Какие подсети ловить (через пробел):\nПример: 84.201 51.250", Menus.backBtn("nav_settings"));
          }
          
          else if (cb === "manage_employees" && isAdmin(chatId)) {
            await tgEdit(chatId, cbMsgId, Menus.employees().text, Menus.employees().markup);
          }
          else if (cb === "add_employee" && isAdmin(chatId)) {
            chatState.step = "AWAIT_EMPLOYEE_ID";
            await tgEdit(chatId, cbMsgId, "Пришлите числовой Telegram ID сотрудника:", Menus.backBtn("manage_employees"));
          }
          else if (cb === "clear_employees" && isAdmin(chatId)) {
            config.allowedUsers = [];
            saveConfig();
            await tgEdit(chatId, cbMsgId, "Список сотрудников полностью очищен", Menus.employees().markup);
          }

          else if (cb.startsWith("acc_")) {
            const acc = getAccount(cb.replace("acc_", ""));
            if (acc) await tgEdit(chatId, cbMsgId, Menus.accountView(acc).text, Menus.accountView(acc).markup);
          }
          else if (cb.startsWith("toggle_")) {
            const acc = getAccount(cb.replace("toggle_", ""));
            if (acc) {
              if (!acc.enabled) {
                try {
                  await resolveIamToken(acc.iamToken);
                  acc.enabled = true;
                  await tgAnswerCb(cbId, "Аккаунт включен");
                } catch {
                  await tgAnswerCb(cbId, "Ошибка токена!", true);
                }
              } else {
                acc.enabled = false;
                await tgAnswerCb(cbId, "Аккаунт выключен");
              }
              saveAccounts();
              await tgEdit(chatId, cbMsgId, Menus.accountView(acc).text, Menus.accountView(acc).markup);
            }
          }
          else if (cb.startsWith("del_")) {
            const id = cb.replace("del_", "");
            const acc = getAccount(id);
            if (acc) {
              acc.deleted = true;
              ACCOUNTS = ACCOUNTS.filter(a => a.id !== id);
              saveAccounts();
              await tgAnswerCb(cbId, "Удалено");
              await tgEdit(chatId, cbMsgId, Menus.accounts().text, Menus.accounts().markup);
            }
          }
          await tgAnswerCb(cbId);
        }
      }
    } catch (e) { console.error("Bot loop error:", e); }
    await new Promise(r => setTimeout(r, 1000));
  }
}

/* ================= YC API & WORKER ================= */

async function resolveIamToken(token: string): Promise<string> {
  if (token.startsWith("t1.")) return token;
  const res = await fetch("https://iam.api.cloud.yandex.net/iam/v1/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yandexPassportOauthToken: token }),
  });
  const data = await res.json();
  if (!data.iamToken) throw new Error("Invalid Token");
  return data.iamToken;
}

async function worker(account: Account) {
  const zones = ["ru-central1-a", "ru-central1-b", "ru-central1-d"];
  let i = 0, errorCount = 0;

  while (!account.deleted) {
    if (!account.enabled) { 
      await new Promise(r => setTimeout(r, 2000)); 
      continue; 
    }

    try {
      const token = await resolveIamToken(account.iamToken);
      const name = `ip-${account.id}-${Date.now()}`;
      
      await fetch(`${YC_API_BASE}/addresses`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ folderId: account.folderId, name, externalIpv4AddressSpec: { zoneId: zones[i++ % 3] } }),
      });
      account.scanned++;
      
      await new Promise(r => setTimeout(r, 2500));

      const listRes = await fetch(`${YC_API_BASE}/addresses?folderId=${account.folderId}`, { headers: authHeaders(token) });
      const list = await listRes.json();
      const addr = list.addresses?.find((x: any) => x.name === name);
      const ip = addr?.externalIpv4Address?.address;

      if (ip && isTargetIp(ip)) {
        account.found++;
        saveAccounts();
        await broadcast(`❗ <b>${account.name}</b>\nПойман айпи - <code>${ip}</code>\n\nРабота продолжается`);
      } else if (addr) {
        await fetch(`${YC_API_BASE}/addresses/${addr.id}`, { method: "DELETE", headers: authHeaders(token) });
      }
      
      errorCount = 0;
      await new Promise(r => setTimeout(r, 800));
    } catch (e: any) {
      errorCount++;
      if (errorCount >= 3) {
        account.enabled = false;
        saveAccounts();
        await broadcast(`❌ Аккаунт <b>${account.name}</b> остановлен\nПричина: многократные ошибки API`);
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function main() {
  botLoop();
  ACCOUNTS.forEach(worker);
}

main().catch(console.error);