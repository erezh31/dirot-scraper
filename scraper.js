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

// Extract item ID from URL (e.g., /item/zvr626ts -> zvr626ts)
const extractItemId = (url) => {
    if (!url) return null;
    const match = url.match(/\/item\/([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
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
            
            // Extract item ID from URL
            const itemId = extractItemId(itemUrl);
            if (!itemId) return; // Skip if no valid item ID
            
            // Skip if we already have this item (dedup)
            if (items.some(item => item.id === itemId)) return;
            
            // Get the parent card/container for better text extraction
            const $card = $link.closest('[class*="item"], [class*="card"], [class*="feed"]').length 
                ? $link.closest('[class*="item"], [class*="card"], [class*="feed"]') 
                : $link.parent();
            
            // Get all text and clean it up
            let rawText = $card.text().trim().replace(/\s+/g, ' ');
            
            // Try to parse the text to extract structured info
            // Yad2 format usually: "₪ PRICE ADDRESS TYPE, AREA ROOMS • קומה FLOOR • SIZE מ״ר"
            const priceMatch = rawText.match(/₪\s*([\d,]+)/);
            const roomsMatch = rawText.match(/([\d.]+)\s*חדרים/);
            const floorMatch = rawText.match(/קומה\s*[‎]*([\dקרקע]+)/);
            const sizeMatch = rawText.match(/([\d,]+)\s*מ[״"']?ר/);
            
            const price = priceMatch ? `₪${priceMatch[1]}` : '';
            const rooms = roomsMatch ? `${roomsMatch[1]} חדרים` : '';
            const floor = floorMatch ? `קומה ${floorMatch[1]}` : '';
            const size = sizeMatch ? `${sizeMatch[1]} מ״ר` : '';
            
            // Build a clean summary text - remove duplicates that Yad2 sometimes has
            let text = rawText.substring(0, 300);
            
            // Remove duplicate price patterns like "₪ 12,000₪ 12,000" -> "₪ 12,000"
            text = text.replace(/(₪\s*[\d,]+)(₪\s*[\d,]+)/g, '$1');
            
            // Remove other duplicate patterns (exact half duplicates)
            if (text.length > 100) {
                const halfLen = Math.floor(text.length / 2);
                const firstHalf = text.substring(0, halfLen);
                const secondHalf = text.substring(halfLen);
                if (firstHalf === secondHalf) {
                    text = firstHalf;
                }
            }
            
            // Clean up any double spaces
            text = text.replace(/\s+/g, ' ').trim();
            
            // Skip items without a price (likely unrelated/ads)
            if (!price) {
                return;
            }
            
            items.push({
                id: itemId,
                imageUrl: imgSrc,
                url: itemUrl || '',
                price,
                rooms,
                floor,
                size,
                text: text || 'דירה להשכרה'
            });
        }
    });
    
    console.log(`Extracted ${items.length} items with price`);
    return items;
}

const checkIfHasNewItems = async (items, topic, maxNewItems) => {
    const filePath = `./data/${topic}.json`;
    let savedItems = {};
    
    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(fileContent);
        
        // Handle migration from old array format to new dict format
        if (Array.isArray(parsed)) {
            console.log('Migrating from old array format to new dict format...');
            savedItems = {};
        } else {
            savedItems = parsed;
        }
    } catch (e) {
        if (e.code === "ENOENT") {
            try {
                fs.mkdirSync('data');
            } catch (mkdirErr) {
                // Directory might already exist
            }
            fs.writeFileSync(filePath, '{}');
        } else {
            console.log(e);
            throw new Error(`Could not read / create ${filePath}`);
        }
    }
    
    // Find NEW items (not in saved dict) - these are items we haven't seen before
    const allNewItems = items.filter(item => !savedItems[item.id]);
    
    // Limit to maxNewItems for notifications
    const newItemsToNotify = allNewItems.slice(0, maxNewItems);
    
    if (allNewItems.length > 0) {
        console.log(`=== New Items Found for "${topic}" ===`);
        console.log(`Total new items: ${allNewItems.length}`);
        console.log(`Will notify for: ${newItemsToNotify.length} items`);
        newItemsToNotify.forEach((item, index) => {
            console.log(`${index + 1}. [${item.id}] ${item.text?.substring(0, 60)}...`);
        });
        console.log('=====================================');
        
        // Only save the items we're notifying about
        newItemsToNotify.forEach(item => {
            savedItems[item.id] = {
                imageUrl: item.imageUrl,
                url: item.url,
                price: item.price,
                rooms: item.rooms,
                floor: item.floor,
                size: item.size,
                text: item.text,
                addedAt: new Date().toISOString()
            };
        });
        
        const updatedData = JSON.stringify(savedItems, null, 2);
        fs.writeFileSync(filePath, updatedData);
        await createPushFlagForWorkflow();
    }
    
    return newItemsToNotify;
}

const createPushFlagForWorkflow = () => {
    fs.writeFileSync("push_me", "")
}

// Execution metadata management
const EXECUTION_META_PATH = './data/execution_meta.json';

const getExecutionMeta = () => {
    try {
        const content = fs.readFileSync(EXECUTION_META_PATH, 'utf-8');
        return JSON.parse(content);
    } catch (e) {
        return { projects: {} };
    }
};

const updateExecutionMeta = (topic, success = true) => {
    const meta = getExecutionMeta();
    meta.projects[topic] = {
        lastExecution: new Date().toISOString(),
        success
    };
    fs.writeFileSync(EXECUTION_META_PATH, JSON.stringify(meta, null, 2));
    createPushFlagForWorkflow();
};

const getNextProjectToRun = (activeProjects) => {
    const meta = getExecutionMeta();
    
    // Find the project with the oldest last execution (or never executed)
    let oldestProject = null;
    let oldestTime = Infinity;
    
    for (const project of activeProjects) {
        const projectMeta = meta.projects[project.topic];
        
        if (!projectMeta) {
            // Never executed - run this one
            console.log(`Project "${project.topic}" has never been executed - selecting it`);
            return project;
        }
        
        const lastExecution = new Date(projectMeta.lastExecution).getTime();
        if (lastExecution < oldestTime) {
            oldestTime = lastExecution;
            oldestProject = project;
        }
    }
    
    if (oldestProject) {
        const timeSince = Math.round((Date.now() - oldestTime) / 1000 / 60);
        console.log(`Project "${oldestProject.topic}" was last executed ${timeSince} minutes ago - selecting it`);
    }
    
    return oldestProject;
};

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
    if (item.rooms) {
        caption += `🚪 חדרים: ${item.rooms}\n`;
    }
    if (item.floor) {
        caption += `🏢 קומה: ${item.floor}\n`;
    }
    if (item.size) {
        caption += `📐 גודל: ${item.size}\n`;
    }
    
    // Add the text summary
    if (item.text && item.text !== 'דירה להשכרה') {
        const cleanText = item.text.substring(0, 200);
        caption += `\n📝 ${cleanText}`;
    }
    
    // Add the URL link at the end
    if (item.url) {
        caption += `\n\n🔗 <a href="${item.url}">לצפייה במודעה</a>`;
    }
    
    return caption;
}

const scrape = async (topic, url) => {
    const apiToken = process.env.API_TOKEN || config.telegramApiToken;
    const chatId = process.env.CHAT_ID || config.chatId;
    const telenode = new Telenode({apiToken})
    
    try {
        const scrapedItems = await scrapeItems(url);
        console.log(`Found ${scrapedItems.length} total items for "${topic}"`);
        
        // Check ALL items against saved data, but limit NEW items to maxResultsPerRun
        const newItems = await checkIfHasNewItems(scrapedItems, topic, maxResultsPerRun);
        
        if (newItems.length > 0) {
            console.log(`Sending ${newItems.length} new items to Telegram for "${topic}"`);
            
            // Send summary message
            await sendTelegramMessage(
                telenode, 
                `🎉 נמצאו ${newItems.length} דירות חדשות!`, 
                chatId
            );
            
            // Send each item as a separate photo message
            for (const item of newItems) {
                const caption = formatItemCaption(item, topic);
                await sendTelegramPhoto(apiToken, chatId, item.imageUrl, caption);
                
                // Delay between messages to avoid Telegram rate limiting
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
            
        } else {
            console.log(`No new items found for "${topic}"`);
        }
    } catch (e) {
        console.error('Scrape error:', e);
        let errMsg = e?.message || String(e);
        try {
            await sendTelegramMessage(telenode, `❌ הסריקה נכשלה... 😥\n${errMsg}`, chatId);
        } catch (telegramErr) {
            console.error('Failed to send error message to Telegram:', telegramErr);
        }
        throw e;
    }
}

const program = async () => {
    console.log(`Max results per run: ${maxResultsPerRun}`);
    
    // Get active projects
    const activeProjects = config.projects.filter(project => {
        if (project.disabled) {
            console.log(`Topic "${project.topic}" is disabled. Skipping.`);
        }
        return !project.disabled;
    });
    
    if (activeProjects.length === 0) {
        console.log('No active projects to run');
        return;
    }
    
    // Select ONE project to run - the one that hasn't been updated the longest
    const projectToRun = getNextProjectToRun(activeProjects);
    
    if (!projectToRun) {
        console.log('No project selected to run');
        return;
    }
    
    console.log(`\n🎯 Running single project: "${projectToRun.topic}"\n`);
    
    try {
        await scrape(projectToRun.topic, projectToRun.url);
        updateExecutionMeta(projectToRun.topic, true);
        console.log(`\n✅ Successfully completed "${projectToRun.topic}"`);
    } catch (e) {
        updateExecutionMeta(projectToRun.topic, false);
        console.error(`\n❌ Failed to complete "${projectToRun.topic}":`, e.message);
        throw e;
    }
};

program();
