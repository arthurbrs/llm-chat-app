/**
 * LLM Chat App Frontend
 *
 * Handles the chat UI interactions and communication with the backend API.
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

// Chat state
let chatHistory = [
	{
		role: "assistant",
		content:
			"Hello! I'm an LLM chat app. Choose an agent above and ask me anything.",
	},
];
let isProcessing = false;

// Helper: get selected agent from index script (fallback safe)
function getAgent() {
	try {
		if (typeof window.getSelectedAgent === "function") {
			return window.getSelectedAgent() || "azure";
		}
	} catch (_) {}
	return "azure";
}

// Auto-resize textarea as user types
userInput.addEventListener("input", function () {
	this.style.height = "auto";
	this.style.height = this.scrollHeight + "px";
});

// Send message on Enter (without Shift)
userInput.addEventListener("keydown", function (e) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

// Send button click handler
sendButton.addEventListener("click", sendMessage);

/**
 * Sends a message to the chat API and processes the response
 */
async function sendMessage() {
	const message = userInput.value.trim();

	// Don't send empty messages
	if (message === "" || isProcessing) return;

	const agent = getAgent();

	// Disable input while processing
	isProcessing = true;
	userInput.disabled = true;
	sendButton.disabled = true;

	// Add user message to chat
	addMessageToChat("user", message);

	// Clear input
	userInput.value = "";
	userInput.style.height = "auto";

	// Show typing indicator
	typingIndicator.classList.add("visible");

	// Add message to history
	chatHistory.push({ role: "user", content: message });

	try {
		// Create new assistant response element
		const assistantMessageEl = document.createElement("div");
		assistantMessageEl.className = "message assistant-message";

		// Agent badge (small, non-invasive)
		const badge = document.createElement("div");
		badge.textContent = agent === "cf" ? "Cloudflare" : "Azure";
		badge.style.fontSize = "0.75rem";
		badge.style.color = "#6b7280";
		badge.style.marginBottom = "0.25rem";

		const p = document.createElement("p");
		assistantMessageEl.appendChild(badge);
		assistantMessageEl.appendChild(p);

		chatMessages.appendChild(assistantMessageEl);
		const assistantTextEl = p;

		// Scroll to bottom
		chatMessages.scrollTop = chatMessages.scrollHeight;

		// Send request to API
		const response = await fetch("/api/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				agent, // ✅ NEW
				messages: chatHistory,
			}),
		});

		// Handle errors
		if (!response.ok) {
			let details = "";
			try {
				details = await response.text();
			} catch (_) {}
			throw new Error(`Failed to get response (${response.status}) ${details}`);
		}
		if (!response.body) {
			throw new Error("Response body is null");
		}

		// Process streaming response
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let responseText = "";
		let buffer = "";

		const flushAssistantText = () => {
			assistantTextEl.textContent = responseText;
			chatMessages.scrollTop = chatMessages.scrollHeight;
		};

		let sawDone = false;
		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				// Process any remaining complete events in buffer
				const parsed = consumeSseEvents(buffer + "\n\n");
				for (const data of parsed.events) {
					if (data === "[DONE]") break;
					appendChunkFromSseData(data);
				}
				break;
			}

			// Decode chunk
			buffer += decoder.decode(value, { stream: true });

			const parsed = consumeSseEvents(buffer);
			buffer = parsed.buffer;

			for (const data of parsed.events) {
				if (data === "[DONE]") {
					sawDone = true;
					buffer = "";
					break;
				}
				appendChunkFromSseData(data);
			}

			if (sawDone) break;
		}

		function appendChunkFromSseData(data) {
			try {
				const jsonData = JSON.parse(data);

				// Handle both Workers AI format (response) and OpenAI/Azure format (choices[0].delta.content)
				let content = "";
				if (typeof jsonData.response === "string" && jsonData.response.length > 0) {
					content = jsonData.response;
				} else if (jsonData.choices?.[0]?.delta?.content) {
					content = jsonData.choices[0].delta.content;
				}

				if (content) {
					responseText += content;
					flushAssistantText();
				}
			} catch (e) {
				// Some providers can send keep-alives or non-JSON "data:" frames. Ignore safely.
				// console.debug("Non-JSON SSE frame:", data);
			}
		}

		// Add completed response to chat history
		if (responseText.length > 0) {
			chatHistory.push({ role: "assistant", content: responseText });
		}
	} catch (error) {
		console.error("Error:", error);
		addMessageToChat("assistant", "Sorry, there was an error processing your request.");
	} finally {
		// Hide typing indicator
		typingIndicator.classList.remove("visible");

		// Re-enable input
		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
		userInput.focus();
	}
}

/**
 * Helper function to add message to chat
 */
function addMessageToChat(role, content) {
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message`;
	messageEl.innerHTML = `<p>${escapeHtml(content)}</p>`;
	chatMessages.appendChild(messageEl);

	// Scroll to bottom
	chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Basic HTML escape to prevent injecting markup in messages
function escapeHtml(str) {
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function consumeSseEvents(buffer) {
	let normalized = buffer.replace(/\r/g, "");
	const events = [];
	let eventEndIndex;
	while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
		const rawEvent = normalized.slice(0, eventEndIndex);
		normalized = normalized.slice(eventEndIndex + 2);

		const lines = rawEvent.split("\n");
		const dataLines = [];
		for (const line of lines) {
			if (line.startsWith("data:")) {
				dataLines.push(line.slice("data:".length).trimStart());
			}
		}
		if (dataLines.length === 0) continue;
		events.push(dataLines.join("\n"));
	}
	return { events, buffer: normalized };
}