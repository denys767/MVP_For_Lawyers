import puppeteer from 'puppeteer';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import OpenAI from "openai";
import cron from 'node-cron';

dotenv.config();

const { TELEGRAM_TOKEN, OPENAI_API_KEY, TARGET_URLS } = process.env;

if (!TELEGRAM_TOKEN || !OPENAI_API_KEY || !TARGET_URLS) {
  throw new Error('Переконайтеся, що TELEGRAM_TOKEN, OPENAI_API_KEY та TARGET_URLS задані у файлі .env');
}

const bot = new Telegraf(TELEGRAM_TOKEN);
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});
const urls = TARGET_URLS.split(',').map(url => url.trim());
const subscribersFilePath = './subscribers.json';

// Функція для завантаження підписників з файлу
async function loadSubscribers() {
  try {
    const data = await fs.readFile(subscribersFilePath, 'utf-8');
    return new Set(JSON.parse(data));
  } catch {
    return new Set();
  }
}

// Функція для збереження підписників у файл
async function saveSubscribers(subscribers) {
  await fs.writeFile(subscribersFilePath, JSON.stringify([...subscribers], null, 2));
}

let subscribers = await loadSubscribers();

// Функція для отримання змісту сторінки
async function fetchPageContent(url) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForNetworkIdle({ idleTime: 1000 });

  const content = await page.evaluate(() => document.body.innerText.trim());
  await browser.close();
  return content;
}

// Функція для збереження змісту у файл
async function saveContentToFile(url, content) {
  const filename = `./content_${encodeURIComponent(url)}.json`;
  await fs.writeFile(filename, JSON.stringify({ content }, null, 2));
}

// Функція для читання змісту з файлу
async function readContentFromFile(url) {
  const filename = `./content_${encodeURIComponent(url)}.json`;
  try {
    const data = await fs.readFile(filename, 'utf-8');
    return JSON.parse(data).content;
  } catch {
    return null;
  }
}

// Функція для порівняння змісту
async function compareContent(oldContent, newContent) {
  const prompt = `
Порівняй наступні два тексти та опиши основні зміни:

Старий текст:
${oldContent}

Новий текст:
${newContent}

Підсумок змін:
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Ти допомагаєш створювати короткі вижимки (порівняння) тексту." },
        { role: "user", content: prompt }
      ],
      max_tokens: 1500,
      temperature: 0.5,
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('Помилка при виклику OpenAI API:', error.message);
    return 'Не вдалося підсумувати зміни.';
  }
}

// Функція перевірки змін
async function checkForChanges(url) {
  const newContent = await fetchPageContent(url);
  const oldContent = await readContentFromFile(url);

  if (!oldContent) {
    await saveContentToFile(url, newContent);
    return `Перевірка виконана для ${url}. Контент збережено для майбутніх порівнянь.`;
  }

  if (newContent === oldContent) {
    return `Для ${url} змін не знайдено.`;
  }

  const summary = await compareContent(oldContent, newContent);
  await saveContentToFile(url, newContent);
  return `Для ${url}: ${summary}`;
}

// Telegram бот
bot.start(async (ctx) => {
  subscribers.add(ctx.chat.id);
  await saveSubscribers(subscribers);
  ctx.reply('Ви підписані на повідомлення про зміни.');
});

bot.command('unsubscribe', async (ctx) => {
  subscribers.delete(ctx.chat.id);
  await saveSubscribers(subscribers);
  ctx.reply('Ви більше не підписані на повідомлення про зміни.');
});

bot.command('check', async (ctx) => {
  ctx.reply('Перевіряю зміни, зачекайте...');
  for (const url of urls) {
    const result = await checkForChanges(url);
    ctx.reply(result);
  }
});

// Автоматична перевірка щодня о 18:00 через node-cron
cron.schedule('* * * * *', async () => {
  for (const url of urls) {
    const result = await checkForChanges(url);

    for (const chatId of subscribers) {
      bot.telegram.sendMessage(chatId, result);
    }
  }
});

bot.launch();

console.log('Telegram бот запущений!');
