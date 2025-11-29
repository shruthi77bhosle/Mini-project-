// extension/popup.js
// Full, standalone popup script for Review Summarizer extension.
const BACKEND_URL = 'http://127.0.0.1:5000/analyze'; // Your Flask server URL

// Helper functions
const $ = (id) => document.getElementById(id);
const show = (id) => $(id)?.classList.remove('hidden');
const hide = (id) => $(id)?.classList.add('hidden');
const setText = (id, text) => { const el = $(id); if (el) el.innerText = text || ''; };

// Query the active tab and inject a function that scrapes the DOM
async function queryActiveTabAndScrape() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found.');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      // --- START OF INJECTED CODE ---

      /**
       * Cleans raw scraped text by removing common review metadata and noise.
       * @param {string} text - The raw text content from a review element.
       * @returns {string} - The cleaned text, or an empty string if it's all noise.
       */
      function cleanReviewText(text) {
        if (!text) return '';
        let cleanedText = text;

        // 1. Remove common noise phrases, ignoring case (i/g)
        const noisePatterns = [
          /(\d\.\d out of 5 stars)/gi,
          /Reviewed in India on .*/gi,
          /Reviewed in the United Arab Emirates on .*/gi,
          /Verified Purchase/gi,
          /Helpful/gi,
          /Report/gi,
          /\d+ people found this helpful/gi,
          /One person found this helpful/gi
        ];
        noisePatterns.forEach(pattern => {
          cleanedText = cleanedText.replace(pattern, '');
        });

        // 2. Remove lines that are likely usernames or dates
        const lines = cleanedText.split('\n');
        const cleanLines = lines.filter(line => {
          const trimmed = line.trim();
          // Keep lines that are longer and look like sentences.
          return trimmed.length > 15 && trimmed.includes(' ');
        });

        // 3. Re-join, remove extra whitespace, and return
        cleanedText = cleanLines.join(' ').replace(/\s\s+/g, ' ').trim();
        return cleanedText;
      }
      
      /**
       * Scrapes text from a list of CSS selectors and cleans it.
       * @param {string[]} selectors - An array of CSS selectors to try.
       * @returns {string[]} - An array of cleaned, unique review strings.
       */
      function gatherTextFromSelectors(selectors) {
        const out = [];
        const uniqueTexts = new Set(); // Use a Set to prevent duplicates

        selectors.forEach(sel => {
          try {
            document.querySelectorAll(sel)?.forEach(el => {
              const rawText = (el.innerText || el.textContent || '').trim();
              const cleanedText = cleanReviewText(rawText); // Clean the text

              // Filter out empty or very short lines AFTER cleaning and check for duplicates
              if (cleanedText && cleanedText.length > 20 && !uniqueTexts.has(cleanedText)) {
                uniqueTexts.add(cleanedText);
                out.push(cleanedText);
              }
            });
          } catch (e) {
            // ignore bad selectors
          }
        });
        return out;
      }

      // Candidate selectors for popular sites
      const reviewSelectors = [
        '#cm_cr-review_list .review-text-content span', // Amazon older
        '[data-hook="review-body"] span',              // Amazon newer
        '.review-text',                                // Generic
        '.a-section.review',                           // Generic Amazon
        '.q4Rxxz',                                     // Flipkart: example class
        '._16PBlm',                                    // Flipkart review container
        '.comment',                                    // Generic
        '.review'                                      // Generic
      ];
      
      let reviews = gatherTextFromSelectors(reviewSelectors);

      // Detect product title
      const titleSelectors = ['#productTitle', '.B_NuCI', 'h1', '.yhB1nd', '.itvQmW'];
      let title = '';
      for (const s of titleSelectors) {
        try {
          const el = document.querySelector(s);
          if (el && (el.innerText || el.textContent)) {
            title = (el.innerText || el.textContent).trim();
            break;
          }
        } catch (e) { /* ignore */ }
      }

      // Return a clean object to the extension
      return {
        reviews: reviews.slice(0, 30), // Limit number of reviews
        title: title,
        url: location.href
      };
      // --- END OF INJECTED CODE ---
    }
  });

  const scraped = results?.[0]?.result;
  if (!scraped) throw new Error('Failed to scrape the page.');
  return scraped;
}

// Send reviews to backend and return parsed JSON
async function callBackend(reviewsObj) {
  const response = await fetch(BACKEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reviewsObj)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Backend request failed: ${response.status} ${text}`);
  }
  return await response.json();
}

// Render structured results to the popup UI
function renderResults(data) {
  if (data.raw && typeof data.raw === 'string') {
    setText('oneLine', data.raw.trim());
    setText('sentimentBadge', '—');
    setText('scoreBadge', '');
    $('prosList').innerHTML = '';
    $('consList').innerHTML = '';
    return;
  }

  const pros = data.pros || [];
  const cons = data.cons || [];
  const overall = data.overall_sentiment || 'N/A';
  const score = (typeof data.score === 'number') ? data.score : null;
  const oneLine = data.one_line_summary || '';

  setText('oneLine', oneLine || `${overall} (${score !== null ? score.toFixed(2) : '—'})`);
  setText('sentimentBadge', overall);
  setText('scoreBadge', score !== null ? `Score: ${Number(score).toFixed(2)}` : '');

  const prosList = $('prosList');
  prosList.innerHTML = '';
  if (pros.length > 0) {
    pros.forEach(p => {
      const li = document.createElement('li');
      li.innerText = p;
      prosList.appendChild(li);
    });
  } else {
    prosList.innerHTML = '<li>No clear pros detected.</li>';
  }

  const consList = $('consList');
  consList.innerHTML = '';
  if (cons.length > 0) {
    cons.forEach(c => {
      const li = document.createElement('li');
      li.innerText = c;
      consList.appendChild(li);
    });
  } else {
    consList.innerHTML = '<li>No clear cons detected.</li>';
  }
}

// Main flow triggered by button
async function summarize() {
  try {
    hide('error');
    hide('result');
    show('loader');

    const scraped = await queryActiveTabAndScrape();
    if (!scraped || !scraped.reviews || scraped.reviews.length === 0) {
      throw new Error('No reviews found on this page. Try opening the "all reviews" section.');
    }

    setText('productInfo', scraped.title || 'Product Page');
    
    const payload = {
      reviews: scraped.reviews,
      title: scraped.title || '',
      url: scraped.url || ''
    };
    const backendData = await callBackend(payload);

    renderResults(backendData);
    hide('loader');
    show('result');
  } catch (err) {
    hide('loader');
    setText('error', err.message || String(err));
    show('error');
  }
}

// Wire UI event listeners
document.addEventListener('DOMContentLoaded', () => {
  $('summarizeBtn')?.addEventListener('click', summarize);
  
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      setText('productInfo', tab?.title || 'Open a product page and click Summarize');
    } catch (e) { /* ignore */ }
  })();
});