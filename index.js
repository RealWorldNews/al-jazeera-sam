PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 1;
const chromium = process.env.AWS_EXECUTION_ENV ? require('@sparticuz/chromium') : null;
const puppeteer = require('puppeteer');
const fs = require('fs');
const { Client } = require('pg');
const cuid = require('cuid');
require('dotenv').config();

const processBody = (body, link, resource = 'Al Jazeera') => {
  let formattedBody = '';
  if (body) {
    formattedBody += body; // Retain the body content as extracted, with all formatting
  }
  formattedBody += `<br><br><ul><li><a href='${link}'>Visit ${resource}</a></li></ul>`;
  return formattedBody;
};

// Function to remove HTML tags from a string
const stripHtml = (html) => {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;
  return tempDiv.textContent || tempDiv.innerText || '';
};

const insertArticleIntoDatabase = async (client, article) => {
  await client.query(
    `INSERT INTO "Article" (id, slug, headline, summary, body, author, resource, media, link, date) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      article.id,
      article.slug,
      article.headline,
      article.summary || '',
      article.body || '',
      article.author,
      article.resource,
      article.media,
      article.link,
      article.date
    ]
  );
};

exports.handler = async (event, context) => {
  const websiteUrl = 'https://www.aljazeera.com'; // Al Jazeera URL

  const client = new Client({
    connectionString: process.env.POSTGRES_CONNECTION_STRING_DEV
  });

  console.log('Connecting to the database...');
  let result;
  try {
    await client.connect();
    console.log('Connected to the database successfully.');

    await client.query('DELETE FROM "Article" WHERE resource = $1', ['Al Jazeera']);
    console.log('Truncated existing articles with resource "Al Jazeera".');

    const browser = await puppeteer.launch({
      args: chromium ? chromium.args : [],
      defaultViewport: chromium ? chromium.defaultViewport : null,
      executablePath: chromium ? await chromium.executablePath() : puppeteer.executablePath(),
      headless: chromium ? chromium.headless : true,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    console.log('Navigating to Al Jazeera website...');
    try {
      await page.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log('Page loaded successfully');

      const cookieButtonSelector = '#onetrust-accept-btn-handler';
      if (await page.$(cookieButtonSelector)) {
        console.log('Cookie consent banner found, clicking "Allow all"...');
        await page.click(cookieButtonSelector);
      }

      console.log('Scrolling down to find the trending articles section...');
      let trendingArticlesFound = false;

      while (!trendingArticlesFound) {
        trendingArticlesFound = (await page.$('.trending-articles')) !== null;
        if (!trendingArticlesFound) {
          console.log('Scrolling down...');
          await page.evaluate(() => window.scrollBy(0, window.innerHeight));
          await page.waitForTimeout(1000);
        }
      }

      console.log('Trending articles section found.');
      
      const articles = await page.$$eval('.trending-articles__list li', items =>
        items.map(item => {
          const headline = item.querySelector('.article-trending__title span')?.innerText.trim();
          const link = 'https://www.aljazeera.com' + item.querySelector('.article-trending__title-link')?.getAttribute('href').trim();
          const slug = headline.split(' ').slice(0, 3).join('').toLowerCase().replace(/[^a-z]/g, '');
          return { headline, link, slug };
        })
      );

      console.log('Collected headlines and links:', articles);

      for (const article of articles) {
        console.log(`Visiting article: ${article.headline}`);
        let success = false;
        let attempts = 0;

        while (!success && attempts < 3) {
          attempts++;
          try {
            await page.goto(article.link, { waitUntil: 'domcontentloaded', timeout: 10000 });

            // Extract body
            try {
              article.body = await page.$eval('div.wysiwyg, div.wysiwyg--all-content', el => {
                const elementsToRemove = ['.more-on', '.sib-newsletter-form', '.advertisement', '.ad-container', '.widget'];
                
                // Remove unwanted elements like ads, newsletter forms, etc.
                elementsToRemove.forEach(selector => {
                  const elements = el.querySelectorAll(selector);
                  elements.forEach(element => element.remove());
                });
                
                // Capture all content including <h2>, <p>, and <img> tags
                let bodyContent = '';
                
                el.querySelectorAll('h2, p, img').forEach(node => {
                  if (node.nodeName === 'IMG') {
                    const imgSrc = node.getAttribute('src');
                    const imgAlt = node.getAttribute('alt') || '';
                    bodyContent += `<figure><img src="${imgSrc}" alt="${imgAlt}"/><figcaption>${imgAlt}</figcaption></figure>`;
                  } else {
                    bodyContent += `<${node.nodeName.toLowerCase()}>${node.innerText.trim()}</${node.nodeName.toLowerCase()}>`;
                  }
                });
                
                return bodyContent;
              });
            } catch (err) {
              console.error('Error extracting full body content:', err);
              article.body = '';
            }
            
            article.body = processBody(article.body, article.link);
            
            // Extract and clean the summary
            try {
              article.summary = await page.$eval('#wysiwyg li', el => el.innerText.split(' ').slice(0, 40).join(' '));
            } catch (err) {
              try {
                article.summary = await page.$eval('.article__subhead em', el => el.innerText.trim());
              } catch (err) {
                try {
                  article.summary = await page.$eval('#wysiwyg p', el => el.innerText.split(' ').slice(0, 40).join(' ').trim());
                } catch (err) {
                  article.summary = ''; 
                }
              }
            }
            
            // If no summary, strip HTML from the body and use first 25 words
            if (!article.summary || article.summary.length === 0) {
              article.summary = stripHtml(article.body.split(' ').slice(0, 25).join(' ') + '...');
            }

            console.log("summary", article.summary);

            try {
              article.author = await page.$eval('.article-author-name-item a.author-link', el => el?.innerText.trim());
            } catch (err) {
              article.author = 'See article for details';
            }

            try {
              article.media = await extractMainImage(page);
            } catch (err) {
              article.media = 'https://upload.wikimedia.org/wikipedia/en/thumb/8/8f/Al_Jazeera_Media_Network_Logo.svg/1200px-Al_Jazeera_Media_Network_Logo.svg.png';
            }

            try {
              const rawDate = await page.$eval('.date-simple span[aria-hidden="true"]', el => el?.innerText.trim());
              const date = new Date(rawDate);
              article.date = date.toISOString();
            } catch (err) {
              article.date = '';
            }

            article.resource = 'Al Jazeera';
            article.id = cuid();

            // Insert into the database
            await insertArticleIntoDatabase(client, article);
            success = true;
          } catch (error) {
            if (attempts >= 3) {
              console.error(`Failed to load article after 3 attempts: ${article.headline}`);
            }
          }
        }
      }

      fs.writeFileSync('enriched-articles.json', JSON.stringify(articles, null, 2));
      await browser.close();
      
      result = {
        statusCode: 200,
        body: JSON.stringify({
          message: 'Scraping completed successfully',
          articles
        })
      };
    } catch (error) {
      console.error('Error:', error);
      result = { statusCode: 500, body: 'Scraping failed' };
    } finally {
      await client.end();
      console.log('Database connection closed.');
    }
  } catch (error) {
    console.error('Error connecting to the database:', error);
    result = { statusCode: 500, body: 'Database connection failed' };
  }

  return result;  // Return the result for Lambda response
};

// Function to extract the main image
async function extractMainImage(page) {
  try {
    const mediaSelector1 = '.featured-media__image-wrap img';
    let imageUrl = await page.$eval(mediaSelector1, img => img.src);

    if (!imageUrl.startsWith('http')) {
      imageUrl = 'https://www.aljazeera.com' + imageUrl;
    }
    
    return imageUrl;
  } catch (error1) {
    try {
      const mediaSelector2 = 'figure.article-featured-image div.responsive-image img';
      let imageUrl = await page.$eval(mediaSelector2, img => img.src);

      if (!imageUrl.startsWith('http')) {
        imageUrl = 'https://www.aljazeera.com' + imageUrl;
      }

      return imageUrl;
    } catch (error2) {
      return 'https://upload.wikimedia.org/wikipedia/en/thumb/8/8f/Al_Jazeera_Media_Network_Logo.svg/1200px-Al_Jazeera_Media_Network_Logo.svg.png';
    }
  }
}
