const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const { chromium } = require('playwright');
const config = require('./config.json');

// Check if running in test mode (no telegram credentials)
const isTestMode = process.argv.includes('--test') || 
    (!process.env.API_TOKEN && !config.telegramApiToken);

if (isTestMode) {
    console.log('🧪 Running in TEST MODE - Telegram messages will be skipped\n');
}

const getYad2Response = async (url) => {
    try {
        const browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor'
            ]
        });
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 },
            locale: 'he-IL',
            timezoneId: 'Asia/Jerusalem',
            geolocation: { latitude: 32.0853, longitude: 34.7818 },
            permissions: ['geolocation']
        });
        
        // Override navigator properties to avoid detection
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['he-IL', 'he', 'en-US', 'en'] });
            window.chrome = { runtime: {} };
        });
        
        const page = await context.newPage();
        
        const response = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        
        // Simulate human-like behavior
        await page.waitForTimeout(2000);
        await page.mouse.move(100, 200);
        await page.waitForTimeout(500);
        await page.evaluate(() => window.scrollBy(0, 300));
        await page.waitForTimeout(2000);
        
        const status = response.status();
        const statusText = response.statusText();
        const html = await page.content();
        
        console.log(`HTTP Response: ${status} ${statusText} (${html.length} chars)`);
        
        await browser.close();
        return html;
    } catch (err) {
        console.log('Error fetching URL:', err);
        throw err;
    }
}

const scrapeItemsAndExtractImgUrls = async (url) => {
    const yad2Html = await getYad2Response(url);
    if (!yad2Html) {
        throw new Error("Could not get Yad2 response");
    }
    
    const $ = cheerio.load(yad2Html);
    const title = $("title")
    const titleText = title.first().text();
    console.log(`Page title: "${titleText}"`);
    
    if (titleText === "ShieldSquare Captcha") {
        throw new Error("Bot detection");
    }
    
    // Try to find feed items with different selectors
    let $feedItems = $(".feeditem").find(".pic");
    console.log(`Found ${$feedItems.length} items with selector ".feeditem .pic"`);
    
    // Try alternative selectors if main one doesn't work
    if ($feedItems.length === 0) {
        $feedItems = $('[data-testid="feed-item"]');
        console.log(`Found ${$feedItems.length} items with selector '[data-testid="feed-item"]'`);
    }
    if ($feedItems.length === 0) {
        $feedItems = $('[class*="feed"]');
        console.log(`Found ${$feedItems.length} items with selector '[class*="feed"]'`);
    }
    
    const imageUrls = []
    $feedItems.each((_, elm) => {
        const imgSrc = $(elm).find("img").attr('src');
        if (imgSrc && 
            imgSrc.includes('img.yad2.co.il/Pic/') &&  // Only actual listing images
            !imgSrc.includes('placeholder') &&
            !imgSrc.includes('logo')) {
            imageUrls.push(imgSrc)
        }
    })
    return imageUrls;
}

const checkIfHasNewItem = async (imgUrls, topic) => {
    const filePath = `./data/${topic}.json`;
    let savedUrls = [];
    try {
        savedUrls = require(filePath);
    } catch (e) {
        if (e.code === "MODULE_NOT_FOUND") {
            fs.mkdirSync('data');
            fs.writeFileSync(filePath, '[]');
        } else {
            console.log(e);
            throw new Error(`Could not read / create ${filePath}`);
        }
    }
    let shouldUpdateFile = false;
    savedUrls = savedUrls.filter(savedUrl => {
        shouldUpdateFile = true;
        return imgUrls.includes(savedUrl);
    });
    const newItems = [];
    imgUrls.forEach(url => {
        if (!savedUrls.includes(url)) {
            savedUrls.push(url);
            newItems.push(url);
            shouldUpdateFile = true;
        }
    });
    if (newItems.length > 0) {
        console.log(`=== New Items Found for "${topic}" ===`);
        console.log(`Total new items: ${newItems.length}`);
        newItems.forEach((item, index) => {
            console.log(`${index + 1}. ${item}`);
        });
        console.log('=====================================');
    }
    if (shouldUpdateFile) {
        const updatedUrls = JSON.stringify(savedUrls, null, 2);
        fs.writeFileSync(filePath, updatedUrls);
        await createPushFlagForWorkflow();
    }
    return newItems;
}

const createPushFlagForWorkflow = () => {
    fs.writeFileSync("push_me", "")
}

const sendTelegramMessage = async (telenode, message, chatId) => {
    if (isTestMode) {
        console.log(`[Telegram] ${message}`);
        return;
    }
    await telenode.sendTextMessage(message, chatId);
}

const scrape = async (topic, url) => {
    const apiToken = process.env.API_TOKEN || config.telegramApiToken;
    const chatId = process.env.CHAT_ID || config.chatId;
    const telenode = new Telenode({apiToken})
    try {
        await sendTelegramMessage(telenode, `Starting scanning ${topic} on link:\n${url}`, chatId)
        const scrapeImgResults = await scrapeItemsAndExtractImgUrls(url);
        console.log(`Found ${scrapeImgResults.length} total items for "${topic}"`);
        const newItems = await checkIfHasNewItem(scrapeImgResults, topic);
        if (newItems.length > 0) {
            const newItemsJoined = newItems.join("\n----------\n");
            const msg = `${newItems.length} new items:\n${newItemsJoined}`
            console.log(`Sending ${newItems.length} new items to Telegram for "${topic}"`);
            await sendTelegramMessage(telenode, msg, chatId);
        } else {
            console.log(`No new items found for "${topic}"`);
            await sendTelegramMessage(telenode, "No new items were added", chatId);
        }
    } catch (e) {
        let errMsg = e?.message || "";
        if (errMsg) {
            errMsg = `Error: ${errMsg}`
        }
        await sendTelegramMessage(telenode, `Scan workflow failed... 😥\n${errMsg}`, chatId)
        throw new Error(e)
    }
}

const program = async () => {
    await Promise.all(config.projects.filter(project => {
        if (project.disabled) {
            console.log(`Topic "${project.topic}" is disabled. Skipping.`);
        }
        return !project.disabled;
    }).map(async project => {
        await scrape(project.topic, project.url)
    }))
};

program();
