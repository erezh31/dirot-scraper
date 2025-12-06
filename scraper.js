const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const { chromium } = require('playwright');
const config = require('./config.json');

const getYad2Response = async (url) => {
    try {
        const browser = await chromium.launch({
            headless: true
        });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();
        
        const response = await page.goto(url, {
            waitUntil: 'networkidle'
        });
        
        const status = response.status();
        const statusText = response.statusText();
        const headers = response.headers();
        const html = await page.content();
        
        console.log('=== HTTP Response ===');
        console.log(`URL: ${url}`);
        console.log(`Status: ${status} ${statusText}`);
        console.log(`Headers:`, JSON.stringify(headers, null, 2));
        console.log(`Response Body Length: ${html.length} characters`);
        console.log('===================');
        
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
    if (titleText === "ShieldSquare Captcha") {
        throw new Error("Bot detection");
    }
    const $feedItems = $(".feeditem").find(".pic");
    if (!$feedItems) {
        throw new Error("Could not find feed items");
    }
    const imageUrls = []
    $feedItems.each((_, elm) => {
        const imgSrc = $(elm).find("img").attr('src');
        if (imgSrc) {
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

const scrape = async (topic, url) => {
    const apiToken = process.env.API_TOKEN || config.telegramApiToken;
    const chatId = process.env.CHAT_ID || config.chatId;
    const telenode = new Telenode({apiToken})
    try {
        await telenode.sendTextMessage(`Starting scanning ${topic} on link:\n${url}`, chatId)
        const scrapeImgResults = await scrapeItemsAndExtractImgUrls(url);
        console.log(`Found ${scrapeImgResults.length} total items for "${topic}"`);
        const newItems = await checkIfHasNewItem(scrapeImgResults, topic);
        if (newItems.length > 0) {
            const newItemsJoined = newItems.join("\n----------\n");
            const msg = `${newItems.length} new items:\n${newItemsJoined}`
            console.log(`Sending ${newItems.length} new items to Telegram for "${topic}"`);
            await telenode.sendTextMessage(msg, chatId);
        } else {
            console.log(`No new items found for "${topic}"`);
            await telenode.sendTextMessage("No new items were added", chatId);
        }
    } catch (e) {
        let errMsg = e?.message || "";
        if (errMsg) {
            errMsg = `Error: ${errMsg}`
        }
        await telenode.sendTextMessage(`Scan workflow failed... 😥\n${errMsg}`, chatId)
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
