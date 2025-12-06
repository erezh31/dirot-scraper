const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const { chromium } = require('playwright');
const config = require('./config.json');

// Check if running in test mode (no telegram credentials)
const isTestMode = process.argv.includes('--test') || 
    (!process.env.API_TOKEN && !config.telegramApiToken);

const maxResultsPerRun = config.maxResultsPerRun || 5;

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

const scrapeItems = async (url) => {
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
    
    const items = [];
    
    // Try to find feed items - look for the main feed container
    const $feedItems = $('[class*="feeditem"], [class*="feed_item"], [data-testid="feed-item"]');
    console.log(`Found ${$feedItems.length} feed items`);
    
    // If no specific feed items, try to find items with images
    if ($feedItems.length === 0) {
        // Find all links that contain listing images
        $('a').each((_, linkElm) => {
            const $link = $(linkElm);
            const imgSrc = $link.find('img').attr('src');
            
            if (imgSrc && 
                imgSrc.includes('img.yad2.co.il/Pic/') &&
                !imgSrc.includes('placeholder') &&
                !imgSrc.includes('logo')) {
                
                // Get the link URL
                let itemUrl = $link.attr('href');
                if (itemUrl && !itemUrl.startsWith('http')) {
                    itemUrl = 'https://www.yad2.co.il' + itemUrl;
                }
                
                // Try to extract text content from the link or its parent
                let text = $link.text().trim();
                if (!text || text.length < 10) {
                    text = $link.parent().text().trim();
                }
                
                // Clean up the text
                text = text.replace(/\s+/g, ' ').substring(0, 500);
                
                items.push({
                    imageUrl: imgSrc,
                    url: itemUrl || '',
                    text: text || 'דירה להשכרה',
                    id: imgSrc // Use image URL as unique identifier
                });
            }
        });
    } else {
        // Look for links that contain feed items
        $('a').each((_, linkElm) => {
            const $link = $(linkElm);
            const $item = $link.find('[class*="feeditem"], [class*="feed_item"]');
            
            if ($item.length === 0) return;
            
            const imgSrc = $link.find('img').attr('src');
            
            if (imgSrc && 
                imgSrc.includes('img.yad2.co.il/Pic/') &&
                !imgSrc.includes('placeholder') &&
                !imgSrc.includes('logo')) {
                
                // Get the link URL
                let itemUrl = $link.attr('href');
                if (itemUrl && !itemUrl.startsWith('http')) {
                    itemUrl = 'https://www.yad2.co.il' + itemUrl;
                }
                
                // Extract various details from the item
                const price = $link.find('[class*="price"]').text().trim() || 
                              $link.find('[data-testid="price"]').text().trim();
                const location = $link.find('[class*="location"], [class*="address"]').text().trim();
                const rooms = $link.find('[class*="room"]').text().trim();
                const size = $link.find('[class*="square"], [class*="size"]').text().trim();
                
                // Get all text as fallback
                let fullText = $link.text().replace(/\s+/g, ' ').trim().substring(0, 500);
                
                items.push({
                    imageUrl: imgSrc,
                    url: itemUrl || '',
                    price,
                    location,
                    rooms,
                    size,
                    text: fullText,
                    id: imgSrc
                });
            }
        });
    }
    
    console.log(`Extracted ${items.length} items with details`);
    return items;
}

const checkIfHasNewItems = async (items, topic) => {
    const filePath = `./data/${topic}.json`;
    let savedIds = [];
    try {
        savedIds = require(filePath);
    } catch (e) {
        if (e.code === "MODULE_NOT_FOUND") {
            try {
                fs.mkdirSync('data');
            } catch (mkdirErr) {
                // Directory might already exist
            }
            fs.writeFileSync(filePath, '[]');
        } else {
            console.log(e);
            throw new Error(`Could not read / create ${filePath}`);
        }
    }
    
    let shouldUpdateFile = false;
    
    // Filter out items that no longer exist
    savedIds = savedIds.filter(savedId => {
        const exists = items.some(item => item.id === savedId);
        if (!exists) shouldUpdateFile = true;
        return exists;
    });
    
    // Find new items
    const newItems = items.filter(item => !savedIds.includes(item.id));
    
    if (newItems.length > 0) {
        console.log(`=== New Items Found for "${topic}" ===`);
        console.log(`Total new items: ${newItems.length}`);
        newItems.forEach((item, index) => {
            console.log(`${index + 1}. ${item.imageUrl}`);
            if (item.price) console.log(`   Price: ${item.price}`);
            if (item.location) console.log(`   Location: ${item.location}`);
        });
        console.log('=====================================');
        
        // Add new item IDs to saved list
        newItems.forEach(item => savedIds.push(item.id));
        shouldUpdateFile = true;
    }
    
    if (shouldUpdateFile) {
        const updatedIds = JSON.stringify(savedIds, null, 2);
        fs.writeFileSync(filePath, updatedIds);
        await createPushFlagForWorkflow();
    }
    
    return newItems;
}

const createPushFlagForWorkflow = () => {
    fs.writeFileSync("push_me", "")
}

const sendTelegramMessage = async (telenode, message, chatId) => {
    if (isTestMode) {
        console.log(`[Telegram Text] ${message}`);
        return;
    }
    await telenode.sendTextMessage(message, chatId);
}

const sendTelegramPhoto = async (apiToken, chatId, photoUrl, caption) => {
    if (isTestMode) {
        console.log(`[Telegram Photo] ${photoUrl}`);
        console.log(`[Caption] ${caption}`);
        return;
    }
    
    try {
        const response = await fetch(`https://api.telegram.org/bot${apiToken}/sendPhoto`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                chat_id: chatId,
                photo: photoUrl,
                caption: caption,
                parse_mode: 'HTML'
            })
        });
        
        const result = await response.json();
        if (!result.ok) {
            console.log(`Failed to send photo: ${result.description}`);
            // Fallback to text message if photo fails
            const telenode = new Telenode({ apiToken });
            await telenode.sendTextMessage(`${caption}\n\n📷 ${photoUrl}`, chatId);
        }
    } catch (err) {
        console.log('Error sending photo:', err.message);
    }
}

const formatItemCaption = (item, topic) => {
    let caption = `🏠 <b>דירה חדשה - ${topic}</b>\n\n`;
    
    if (item.price) {
        caption += `💰 מחיר: ${item.price}\n`;
    }
    if (item.location) {
        caption += `📍 מיקום: ${item.location}\n`;
    }
    if (item.rooms) {
        caption += `🚪 חדרים: ${item.rooms}\n`;
    }
    if (item.size) {
        caption += `📐 גודל: ${item.size}\n`;
    }
    
    // Add some of the text if we don't have structured data
    if (!item.price && !item.location && item.text) {
        // Clean and truncate text for caption (Telegram limit is 1024 chars)
        const cleanText = item.text.substring(0, 400);
        caption += `\n${cleanText}`;
    }
    
    // Add the URL link at the end
    if (item.url) {
        caption += `\n\n🔗 <a href="${item.url}">לחץ כאן לצפייה במודעה</a>`;
    }
    
    return caption;
}

const scrape = async (topic, url) => {
    const apiToken = process.env.API_TOKEN || config.telegramApiToken;
    const chatId = process.env.CHAT_ID || config.chatId;
    const telenode = new Telenode({apiToken})
    
    try {
        await sendTelegramMessage(telenode, `🔍 מתחיל סריקה: ${topic}\n${url}`, chatId);
        
        const scrapedItems = await scrapeItems(url);
        console.log(`Found ${scrapedItems.length} total items for "${topic}"`);
        
        const newItems = await checkIfHasNewItems(scrapedItems, topic);
        
        if (newItems.length > 0) {
            // Limit to maxResultsPerRun
            const itemsToSend = newItems.slice(0, maxResultsPerRun);
            const skippedCount = newItems.length - itemsToSend.length;
            
            console.log(`Sending ${itemsToSend.length} new items to Telegram for "${topic}"`);
            if (skippedCount > 0) {
                console.log(`(Skipping ${skippedCount} additional items due to maxResultsPerRun limit)`);
            }
            
            // Send summary message
            await sendTelegramMessage(
                telenode, 
                `🎉 נמצאו ${newItems.length} דירות חדשות!\n${skippedCount > 0 ? `(מציג ${itemsToSend.length} מתוכן)` : ''}`, 
                chatId
            );
            
            // Send each item as a separate photo message
            for (const item of itemsToSend) {
                const caption = formatItemCaption(item, topic);
                await sendTelegramPhoto(apiToken, chatId, item.imageUrl, caption);
                
                // Small delay between messages to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
        } else {
            console.log(`No new items found for "${topic}"`);
            await sendTelegramMessage(telenode, "✅ אין דירות חדשות", chatId);
        }
    } catch (e) {
        let errMsg = e?.message || "";
        if (errMsg) {
            errMsg = `Error: ${errMsg}`
        }
        await sendTelegramMessage(telenode, `❌ הסריקה נכשלה... 😥\n${errMsg}`, chatId)
        throw new Error(e)
    }
}

const program = async () => {
    console.log(`Max results per run: ${maxResultsPerRun}`);
    
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
