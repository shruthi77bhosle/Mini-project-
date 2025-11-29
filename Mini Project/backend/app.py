import os
import json
import re
from statistics import mean
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv
import requests
from textblob import TextBlob

load_dotenv()

app = Flask(__name__)
CORS(app)  # allow requests from the extension while developing

# OpenRouter Configuration
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

# Choose your model here. Examples:
# "google/gemini-2.0-flash-001" (Fast, good)
# "meta-llama/llama-3-8b-instruct:free" (Free option)
# "openai/gpt-3.5-turbo"
OPENROUTER_MODEL = "google/gemini-2.0-flash-001"

MAX_REVIEWS = 30

# Compact stopword list
STOPWORDS = set([
    'the','and','is','in','it','of','to','this','that','with','for','on','was','my','i','its','but','are','very','not','be','have','has'
])


def safe_parse_json(text):
    """Try to extract JSON object from potentially noisy model output."""
    try:
        # find first { and last }
        first = text.index('{')
        last = text.rindex('}')
        candidate = text[first:last+1]
        return json.loads(candidate)
    except Exception:
        return None


def simple_fallback_summary(reviews):
    # sentiment per review (TextBlob)
    polarities = [TextBlob(r).sentiment.polarity for r in reviews]
    avg = mean(polarities) if polarities else 0.0
    overall = 'Positive' if avg > 0.05 else 'Negative' if avg < -0.05 else 'Neutral'

    # keyword extraction: top words from positive and negative reviews
    def top_words(filter_fn):
        words = []
        for r, p in zip(reviews, polarities):
            if filter_fn(p):
                tokens = re.findall(r"\b[a-zA-Z]{3,}\b", r.lower())
                tokens = [t for t in tokens if t not in STOPWORDS]
                words += tokens
        from collections import Counter
        most = [w for w, _ in Counter(words).most_common(6)]
        return most

    pros = top_words(lambda p: p > 0.1)
    cons = top_words(lambda p: p < -0.1)

    return {
        "pros": pros,
        "cons": cons,
        "overall_sentiment": overall,
        "score": avg,
        "one_line_summary": f"Overall {overall} (score={avg:.2f})."
    }


def call_openrouter(system_prompt, user_content):
    try:
        headers = {
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "HTTP-Referer": "http://localhost:5000", # Optional: specific to OpenRouter
            "X-Title": "Review Analyzer",            # Optional: specific to OpenRouter
            "Content-Type": "application/json"
        }

        # OpenRouter uses standard OpenAI format (messages list)
        payload = {
            "model": OPENROUTER_MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content}
            ]
        }

        print("--- SENDING PAYLOAD TO OPENROUTER ---")
        # print(json.dumps(payload, indent=2)) 
        
        resp = requests.post(OPENROUTER_API_URL, headers=headers, json=payload)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        print("OpenRouter request failed:", e)
        if hasattr(e, 'response') and e.response is not None:
            print("Response details:", e.response.text)
        return None


@app.route('/analyze', methods=['POST'])
def analyze():
    data = request.get_json() or {}
    reviews = data.get('reviews', [])[:MAX_REVIEWS]

    if not reviews:
        return jsonify({"error": "No reviews provided"}), 400

    # System prompt: Instructions and JSON enforcement
    system_instruction = (
        "You are a review summarization expert. "
        "Your response MUST be a single, clean JSON object and nothing else. "
        "Do not wrap it in markdown blocks (like ```json). "
        "The JSON object must have these exact keys: 'pros' (list of strings), 'cons' (list of strings), "
        "'overall_sentiment' (string: 'Positive', 'Negative', or 'Mixed'), 'score' (number 0-5), "
        "and 'one_line_summary' (concise string)."
    )

    # User prompt: The actual data
    user_content = (
        "Here are the reviews to analyze:\n"
        + "\n".join(f"- {r}" for r in reviews)
    )

    router_resp = call_openrouter(system_instruction, user_content)
    
    if router_resp:
        try:
            # Extract text from OpenAI/OpenRouter format: choices[0].message.content
            text_content = router_resp['choices'][0]['message']['content']
            
            # Attempt to parse
            parsed_json = safe_parse_json(text_content)
            
            if parsed_json:
                parsed_json["source"] = "openrouter"
                return jsonify(parsed_json)
            else:
                print("OpenRouter output was not valid JSON, returning raw.")
                return jsonify({"source": "openrouter", "raw": text_content})

        except (KeyError, IndexError, Exception) as e:
            print(f"Error processing OpenRouter response: {e}")

    # Fallback
    print("OpenRouter call failed or returned invalid data, using fallback.")
    return jsonify({
        "source": "fallback",
        **simple_fallback_summary(reviews)
    })


if __name__ == '__main__':
    app.run(debug=True, port=5000)