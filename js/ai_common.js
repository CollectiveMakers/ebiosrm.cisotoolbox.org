/**
 * CISO Toolbox — AI Common Module
 *
 * Shared AI infrastructure: providers, API calls, settings panel, panel UI, CSS.
 * Each app adds its own AI assistant that uses these shared functions.
 *
 * Load AFTER i18n.js and cisotoolbox.js, BEFORE app-specific AI assistant:
 *   <script src="js/ai_common.js"></script>
 *
 * Each app must set window.AI_APP_CONFIG before loading this file:
 *   window.AI_APP_CONFIG = {
 *       storagePrefix: "ebios" | "compliance",
 *       onSettingsSaved: function() { ... } // called after settings are saved
 *   };
 */

(function() {
    "use strict";

    var cfg = window.AI_APP_CONFIG || { storagePrefix: "ct" };
    var pfx = cfg.storagePrefix || "ct";


    // ═══════════════════════════════════════════════════════════════════
    // PROVIDERS
    // ═══════════════════════════════════════════════════════════════════

    var AI_PROVIDERS = {
        anthropic: {
            label: "Anthropic (Claude)",
            models: [
                { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
                { id: "claude-opus-4-6", label: "Claude Opus 4.6" }
            ],
            defaultModel: "claude-sonnet-4-6",
            placeholder: "sk-ant-...",
            endpoint: "https://api.anthropic.com/v1/messages"
        },
        openai: {
            label: "OpenAI (GPT)",
            models: [
                { id: "gpt-4o", label: "GPT-4o" },
                { id: "gpt-4o-mini", label: "GPT-4o mini" }
            ],
            defaultModel: "gpt-4o",
            placeholder: "sk-...",
            endpoint: "https://api.openai.com/v1/chat/completions"
        },
        bedrock: {
            label: "AWS Bedrock",
            models: [
                { id: "anthropic.claude-sonnet-4-6-20250514-v1:0", label: "Claude Sonnet 4.6 (Bedrock)" },
                { id: "anthropic.claude-haiku-4-5-20251001-v1:0", label: "Claude Haiku 4.5 (Bedrock)" },
                { id: "anthropic.claude-opus-4-6-20250515-v1:0", label: "Claude Opus 4.6 (Bedrock)" }
            ],
            defaultModel: "anthropic.claude-sonnet-4-6-20250514-v1:0",
            placeholder: "AKIAIOSFODNN7EXAMPLE",
            endpoint: "https://bedrock-runtime.eu-west-3.amazonaws.com"
        }
    };

    // ── AWS SigV4 signing (minimal, for Bedrock) ─────────────────────
    async function _hmac(key, msg) {
        var k = (typeof key === "string") ? new TextEncoder().encode(key) : key;
        var cryptoKey = await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(msg)));
    }
    async function _sha256(msg) {
        var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
        return Array.from(new Uint8Array(buf)).map(function(b) { return b.toString(16).padStart(2, "0"); }).join("");
    }
    async function _signV4(method, url, body, accessKey, secretKey, region, service) {
        var u = new URL(url);
        var now = new Date();
        var dateStamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z/, "Z");
        var shortDate = dateStamp.substring(0, 8);
        var payloadHash = await _sha256(body || "");
        var headers = {
            "host": u.host,
            "x-amz-date": dateStamp,
            "x-amz-content-sha256": payloadHash,
            "content-type": "application/json"
        };
        var signedHeaders = Object.keys(headers).sort().join(";");
        var canonicalHeaders = Object.keys(headers).sort().map(function(k) { return k + ":" + headers[k] + "\n"; }).join("");
        var canonicalRequest = method + "\n" + u.pathname + "\n" + (u.search ? u.search.substring(1) : "") + "\n" + canonicalHeaders + "\n" + signedHeaders + "\n" + payloadHash;
        var credentialScope = shortDate + "/" + region + "/" + service + "/aws4_request";
        var stringToSign = "AWS4-HMAC-SHA256\n" + dateStamp + "\n" + credentialScope + "\n" + (await _sha256(canonicalRequest));
        var kDate = await _hmac("AWS4" + secretKey, shortDate);
        var kRegion = await _hmac(kDate, region);
        var kService = await _hmac(kRegion, service);
        var kSigning = await _hmac(kService, "aws4_request");
        var sig = Array.from(await _hmac(kSigning, stringToSign)).map(function(b) { return b.toString(16).padStart(2, "0"); }).join("");
        headers["authorization"] = "AWS4-HMAC-SHA256 Credential=" + accessKey + "/" + credentialScope + ", SignedHeaders=" + signedHeaders + ", Signature=" + sig;
        return headers;
    }

    // ═══════════════════════════════════════════════════════════════════
    // STORAGE HELPERS (prefixed per app)
    // ═══════════════════════════════════════════════════════════════════

    function _k(suffix) { return pfx + "_ai_" + suffix; }

    window._aiGetApiKey = function() { return localStorage.getItem(_k("apikey")) || ""; };
    window._aiSetApiKey = function(key) { localStorage.setItem(_k("apikey"), key); };
    window._aiClearApiKey = function() { localStorage.removeItem(_k("apikey")); };

    window._aiGetProvider = function() { return localStorage.getItem(_k("provider")) || "anthropic"; };
    window._aiSetProvider = function(p) { localStorage.setItem(_k("provider"), p); };

    window._aiGetEndpoint = function() { return localStorage.getItem(_k("endpoint")) || ""; };
    window._aiSetEndpoint = function(url) { if (url) localStorage.setItem(_k("endpoint"), url); else localStorage.removeItem(_k("endpoint")); };

    window._aiGetSecretKey = function() { return localStorage.getItem(_k("secretkey")) || ""; };
    window._aiSetSecretKey = function(key) { if (key) localStorage.setItem(_k("secretkey"), key); else localStorage.removeItem(_k("secretkey")); };

    window._aiGetRegion = function() { return localStorage.getItem(_k("region")) || "eu-west-3"; };
    window._aiSetRegion = function(r) { if (r) localStorage.setItem(_k("region"), r); else localStorage.removeItem(_k("region")); };

    function _resolveEndpoint(provider) {
        var custom = _aiGetEndpoint();
        if (custom) return custom;
        var p = AI_PROVIDERS[provider] || AI_PROVIDERS.anthropic;
        return p.endpoint;
    }

    window._aiGetModel = function() {
        var stored = localStorage.getItem(_k("model"));
        if (stored) return stored;
        var p = AI_PROVIDERS[_aiGetProvider()];
        return p ? p.defaultModel : "claude-sonnet-4-6";
    };
    window._aiSetModel = function(m) { localStorage.setItem(_k("model"), m); };

    window._aiIsEnabled = function() {
        return localStorage.getItem(_k("enabled")) === "true" && !!_aiGetApiKey();
    };
    window._aiSetEnabled = function(v) { localStorage.setItem(_k("enabled"), v ? "true" : "false"); };

    // Context file (markdown)
    window._aiGetContext = function() { return localStorage.getItem(_k("context")) || ""; };
    window._aiSetContext = function(text) {
        if (text) localStorage.setItem(_k("context"), text);
        else localStorage.removeItem(_k("context"));
    };
    window._aiGetContextName = function() { return localStorage.getItem(_k("context_name")) || ""; };
    window._aiSetContextName = function(name) {
        if (name) localStorage.setItem(_k("context_name"), name);
        else localStorage.removeItem(_k("context_name"));
    };

    // ═══════════════════════════════════════════════════════════════════
    // API CALL
    // ═══════════════════════════════════════════════════════════════════

    // Validate API key with a minimal request (max_tokens=1)
    async function _aiValidateKey(provider, apiKey, model) {
        var providerConf = AI_PROVIDERS[provider] || AI_PROVIDERS.anthropic;
        try {
            // Bedrock: skip validation (SigV4 makes it complex, will fail on first real call)
            if (provider === "bedrock") return true;
            var resp;
            if (provider === "anthropic") {
                resp = await fetch(_resolveEndpoint(provider), {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": apiKey,
                        "anthropic-version": "2023-06-01",
                        "anthropic-dangerous-direct-browser-access": "true"
                    },
                    body: JSON.stringify({
                        model: model,
                        max_tokens: 1,
                        messages: [{ role: "user", content: "hi" }]
                    })
                });
            } else {
                // OpenAI-compatible providers (openai, mistral)
                resp = await fetch(_resolveEndpoint(provider), {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": "Bearer " + apiKey
                    },
                    body: JSON.stringify({
                        model: model,
                        max_tokens: 1,
                        messages: [{ role: "user", content: "hi" }]
                    })
                });
            }
            if (!resp) return false;
            // 401/403 = invalid key, 200 = valid, 400/429 = valid key but bad request or rate limit
            return resp.status !== 401 && resp.status !== 403;
        } catch (e) {
            return false;
        }
    }

    window._aiCallAPI = async function(systemPrompt, userPrompt) {
        // Append user context file if present
        var ctx = _aiGetContext();
        if (ctx) {
            systemPrompt += "\n\n--- METHODOLOGY INSTRUCTIONS (provided by the user) ---\n" + ctx;
        }

        var apiKey = _aiGetApiKey();
        if (!apiKey) return null;

        var provider = _aiGetProvider();
        var providerConf = AI_PROVIDERS[provider] || AI_PROVIDERS.anthropic;
        var model = _aiGetModel();
        var resp, data, text;

        try {
            if (provider === "bedrock") {
                // AWS Bedrock — SigV4 signed request
                var region = _aiGetRegion();
                var secretKey = _aiGetSecretKey();
                var bedrockEndpoint = _resolveEndpoint(provider);
                var bedrockUrl = bedrockEndpoint + "/model/" + encodeURIComponent(model) + "/invoke";
                var bedrockBody = JSON.stringify({
                    anthropic_version: "bedrock-2023-05-31",
                    max_tokens: 4096,
                    system: systemPrompt,
                    messages: [{ role: "user", content: userPrompt }]
                });
                var sigHeaders = await _signV4("POST", bedrockUrl, bedrockBody, apiKey, secretKey, region, "bedrock");
                resp = await fetch(bedrockUrl, {
                    method: "POST",
                    headers: sigHeaders,
                    body: bedrockBody
                });
            } else if (provider === "anthropic") {
                // anthropic-dangerous-direct-browser-access: required by Anthropic
                // for direct browser API calls (no backend proxy). Acceptable for
                // internal/local tools. API key is exposed to browser extensions.
                resp = await fetch(_resolveEndpoint(provider), {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": apiKey,
                        "anthropic-version": "2023-06-01",
                        "anthropic-dangerous-direct-browser-access": "true"
                    },
                    body: JSON.stringify({
                        model: model,
                        max_tokens: 4096,
                        system: systemPrompt,
                        messages: [{ role: "user", content: userPrompt }]
                    })
                });
            } else {
                // OpenAI-compatible providers (openai, mistral)
                resp = await fetch(_resolveEndpoint(provider), {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": "Bearer " + apiKey
                    },
                    body: JSON.stringify({
                        model: model,
                        max_tokens: 4096,
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: userPrompt }
                        ]
                    })
                });
            }
        } catch (e) {
            throw new Error("Network: " + e.message);
        }

        if (!resp) throw new Error("Unknown provider: " + provider);
        if (resp.status === 401 || resp.status === 403) {
            _aiClearApiKey();
            throw new Error(t("ai.invalid_key"));
        }
        if (!resp.ok) {
            var errText = await resp.text();
            throw new Error("API " + resp.status + ": " + errText.substring(0, 200));
        }

        data = await resp.json();
        if (provider === "anthropic" || provider === "bedrock") {
            text = data.content && data.content[0] ? data.content[0].text : "";
        } else {
            // OpenAI-compatible (openai, mistral)
            text = data.choices && data.choices[0] ? data.choices[0].message.content : "";
        }
        return text;
    };

    // Parse JSON from AI response (handles markdown code blocks)
    // Parse JSON from AI response (handles markdown code fences). Returns parsed result as-is.
    window._aiParseJSON = function(raw) {
        var s = raw.trim();
        if (s.startsWith("```")) s = s.replace(/^```json?\s*/i, "").replace(/\s*```$/, "");
        return JSON.parse(s);
    };

    // ═══════════════════════════════════════════════════════════════════
    // SETTINGS PANEL
    // ═══════════════════════════════════════════════════════════════════

    function _buildModelOptions(providerId) {
        var p = AI_PROVIDERS[providerId] || AI_PROVIDERS.anthropic;
        var cur = _aiGetModel();
        var h = "";
        p.models.forEach(function(m) {
            h += '<option value="' + m.id + '"' + (m.id === cur ? ' selected' : '') + '>' + m.label + '</option>';
        });
        return h;
    }

    window.openSettings = function() {
        if (typeof toggleMenu === "function") toggleMenu();

        var key = _aiGetApiKey();
        var curProvider = _aiGetProvider();
        var aiEnabled = localStorage.getItem(_k("enabled")) === "true";
        var providerConf = AI_PROVIDERS[curProvider] || AI_PROVIDERS.anthropic;
        var placeholder = providerConf.placeholder;

        var provOpts = "";
        for (var pid in AI_PROVIDERS) {
            provOpts += '<option value="' + pid + '"' + (pid === curProvider ? ' selected' : '') + '>' + AI_PROVIDERS[pid].label + '</option>';
        }

        var panel = _aiEnsurePanel();
        panel.title.textContent = t("settings.title");
        var _hideAI = cfg.hideAI || false;

        var _settingsHTML =
            // Language
            '<div class="settings-section">' +
                '<div class="settings-label">' + t("settings.language") + '</div>' +
                '<div style="display:flex;gap:8px">' +
                    '<button class="settings-lang-btn' + (_locale === "fr" ? " active" : "") + '" id="settings-lang-fr">Français</button>' +
                    '<button class="settings-lang-btn' + (_locale === "en" ? " active" : "") + '" id="settings-lang-en">English</button>' +
                '</div>' +
            '</div>';

        if (!_hideAI) {
            // Build provider-specific fields — only the selected provider's
            // fields are shown. This keeps the panel clean for operators who
            // only need one provider (the common case).
            function _providerFields(p) {
                var pConf = AI_PROVIDERS[p] || {};
                var h = '';
                // Model dropdown (for providers that define a model list)
                if (pConf.models && pConf.models.length) {
                    h += '<div class="settings-label fs-sm" style="margin-bottom:4px">' + t("settings.model") + '</div>';
                    h += '<select class="settings-input" id="settings-model" style="width:100%;margin-bottom:12px">' + _buildModelOptions(p) + '</select>';
                } else {
                    // Custom: free-text model input
                    h += '<div class="settings-label fs-sm" style="margin-bottom:4px">' + t("settings.model") + '</div>';
                    h += '<input type="text" class="settings-input" id="settings-model" value="' + esc(localStorage.getItem(_k("model")) || "") + '" placeholder="model-name" style="width:100%;margin-bottom:12px">';
                }
                // API key (all providers except custom-without-key)
                if (p !== "custom" || true) {
                    h += '<div class="settings-label fs-sm" style="margin-bottom:4px">' + t("settings.api_key") + (p === "custom" ? ' <span class="text-muted">(optionnel)</span>' : '') + '</div>';
                    h += '<div style="display:flex;gap:6px;align-items:center">';
                    h += '<input type="password" class="settings-input" id="settings-api-key" value="' + esc(key) + '" placeholder="' + esc((pConf.placeholder || "sk-...")) + '" style="flex:1">';
                    h += '<button class="settings-btn-eye" id="settings-toggle-key" title="' + t("settings.show_key") + '">👁</button>';
                    h += '</div>';
                    if (p !== "bedrock" && p !== "custom") {
                        h += '<p class="fs-xs text-muted" style="margin-top:6px">' + t("settings.api_key_note") + '</p>';
                    }
                }
                // Bedrock-specific: secret key + region
                if (p === "bedrock") {
                    h += '<div class="settings-label fs-sm" style="margin-top:12px;margin-bottom:4px">' + t("settings.secret_key") + '</div>';
                    h += '<input type="password" class="settings-input" id="settings-secret-key" value="' + esc(_aiGetSecretKey()) + '" placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" style="width:100%">';
                    h += '<div class="settings-label fs-sm" style="margin-top:8px;margin-bottom:4px">' + t("settings.region") + '</div>';
                    h += '<input type="text" class="settings-input" id="settings-region" value="' + esc(_aiGetRegion()) + '" placeholder="eu-west-3" style="width:100%">';
                }
                // Custom: endpoint is required. Other providers: optional.
                if (p === "custom") {
                    h += '<div class="settings-label fs-sm" style="margin-top:12px;margin-bottom:4px">' + t("settings.endpoint") + ' <span style="color:var(--red)">*</span></div>';
                    h += '<input type="url" class="settings-input" id="settings-endpoint" value="' + esc(_aiGetEndpoint()) + '" placeholder="https://my-llm.example.com/v1/chat/completions" style="width:100%">';
                    h += '<p class="fs-xs text-muted" style="margin-top:4px">' + (t("settings.custom_endpoint_note") || "URL complète du endpoint compatible OpenAI (POST, JSON, messages[]).") + '</p>';
                } else {
                    h += '<div class="settings-label fs-sm" style="margin-top:12px;margin-bottom:4px">' + t("settings.endpoint") + ' <span class="text-muted">(optionnel)</span></div>';
                    h += '<input type="url" class="settings-input" id="settings-endpoint" value="' + esc(_aiGetEndpoint()) + '" placeholder="' + esc((pConf.endpoint || "")) + '" style="width:100%">';
                    h += '<p class="fs-xs text-muted" style="margin-top:4px">' + t("settings.endpoint_note") + '</p>';
                }
                return h;
            }

            // Add "custom" to provider options if not already defined
            var allProviderOpts = provOpts;
            if (!AI_PROVIDERS.custom) {
                allProviderOpts += '<option value="custom"' + (curProvider === "custom" ? ' selected' : '') + '>' + (t("settings.provider_custom") || "Custom LLM") + '</option>';
            }

            _settingsHTML +=
            '<div class="settings-section">' +
                '<div class="settings-label">' + t("settings.ai_section") + '</div>' +
                '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">' +
                    '<label class="settings-toggle"><input type="checkbox" id="settings-ai-toggle"' + (aiEnabled ? " checked" : "") + '><span class="settings-toggle-slider"></span></label>' +
                    '<span class="fs-sm">' + t("settings.ai_enable") + '</span>' +
                '</div>' +
                '<div class="settings-label fs-sm" style="margin-bottom:4px">' + t("settings.provider") + '</div>' +
                '<select class="settings-input" id="settings-provider" style="width:100%;margin-bottom:12px">' + allProviderOpts + '</select>' +
                // Provider-specific fields container — rebuilt on provider change
                '<div id="settings-provider-fields">' + _providerFields(curProvider) + '</div>' +
                // Context file (always visible, not provider-specific)
                '<div class="settings-label fs-sm" style="margin-top:12px;margin-bottom:4px">' + t("settings.context_file") + '</div>' +
                '<div style="display:flex;gap:6px;align-items:center">' +
                    '<input type="file" class="settings-input" id="settings-context-file" accept=".md,.txt,.markdown" style="flex:1;font-family:inherit">' +
                    (_aiGetContextName() ? '<button class="ai-btn-ignore" id="settings-context-clear" style="white-space:nowrap">' + t("settings.context_clear") + '</button>' : '') +
                '</div>' +
                (_aiGetContextName() ? '<p class="fs-xs" style="margin-top:4px;color:var(--green)">&#10003; ' + esc(_aiGetContextName()) + ' (' + Math.round(_aiGetContext().length / 1024) + ' Ko)</p>' : '<p class="fs-xs text-muted" style="margin-top:4px">' + t("settings.context_note") + '</p>') +
            '</div>';
        } else {
            // Hidden AI toggle for save handler compatibility
            _settingsHTML += '<input type="checkbox" id="settings-ai-toggle" style="display:none">';
            _settingsHTML += '<input type="hidden" id="settings-api-key" value="' + esc(key) + '">';
            _settingsHTML += '<input type="hidden" id="settings-provider" value="' + esc(curProvider) + '">';
            _settingsHTML += '<input type="hidden" id="settings-model" value="">';
        }

        // App-specific extra settings (injected via AI_APP_CONFIG.settingsExtraHTML)
        _settingsHTML += (cfg.settingsExtraHTML ? cfg.settingsExtraHTML() : '');

        // Buttons
        _settingsHTML +=
            '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px">' +
                '<button class="ai-btn-close" id="settings-cancel">' + t("ai.close") + '</button>' +
                '<button class="ai-btn-accept" id="settings-save">' + t("settings.save") + '</button>' +
            '</div>';

        panel.body.innerHTML = _settingsHTML;
        panel.footer.innerHTML = "";
        _aiOpenPanel();

        // ai-close-btn already wired in _aiEnsurePanel
        document.getElementById("settings-cancel").onclick = _aiClosePanel;
        document.getElementById("settings-lang-fr").onclick = function() { switchLang("fr"); openSettings(); };
        document.getElementById("settings-lang-en").onclick = function() { switchLang("en"); openSettings(); };
        var toggleKeyBtn = document.getElementById("settings-toggle-key");
        if (toggleKeyBtn) toggleKeyBtn.onclick = function() {
            var inp = document.getElementById("settings-api-key");
            inp.type = inp.type === "password" ? "text" : "password";
        };
        // Context file upload
        var _pendingContext = null;
        var _pendingContextName = null;
        var ctxFile = document.getElementById("settings-context-file");
        if (ctxFile) ctxFile.onchange = function(e) {
            var file = e.target.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function(ev) {
                _pendingContext = ev.target.result;
                _pendingContextName = file.name;
                showStatus(t("settings.context_loaded", {name: file.name}));
            };
            reader.readAsText(file);
        };
        var clearBtn = document.getElementById("settings-context-clear");
        if (clearBtn) clearBtn.onclick = function() {
            _aiSetContext("");
            _aiSetContextName("");
            _pendingContext = null;
            _pendingContextName = null;
            openSettings(); // re-render to update UI
        };

        var provSelect = document.getElementById("settings-provider");
        if (provSelect) provSelect.onchange = function() {
            var p = this.value;
            // Rebuild the provider-specific fields section entirely —
            // cleaner than show/hide, and ensures only relevant fields exist.
            var container = document.getElementById("settings-provider-fields");
            if (container) {
                container.innerHTML = _providerFields(p);
                // Re-wire eye toggle on the new API key input
                var btn = document.getElementById("settings-toggle-key");
                if (btn) btn.onclick = function() {
                    var inp = document.getElementById("settings-api-key");
                    if (inp) inp.type = inp.type === "password" ? "text" : "password";
                };
            }
        };
        document.getElementById("settings-save").onclick = async function() {
            var aiToggle = document.getElementById("settings-ai-toggle").checked;
            var newKey = document.getElementById("settings-api-key").value.trim();
            var newProvider = document.getElementById("settings-provider").value;
            var newModel = document.getElementById("settings-model").value;

            // Cannot enable without a key (except custom provider where key is optional)
            if (aiToggle && !newKey && newProvider !== "custom") {
                alert(t("settings.ai_needs_key"));
                return;
            }
            // Custom provider requires an endpoint
            if (aiToggle && newProvider === "custom") {
                var epVal = (document.getElementById("settings-endpoint") || {}).value || "";
                if (!epVal.trim()) {
                    alert(t("settings.custom_needs_endpoint") || "L'endpoint est requis pour un LLM personnalisé.");
                    return;
                }
            }

            // Validate key if it changed and AI is being enabled
            if (aiToggle && newKey && newKey !== _aiGetApiKey()) {
                var saveBtn = document.getElementById("settings-save");
                var origText = saveBtn.textContent;
                saveBtn.textContent = t("settings.validating_key");
                saveBtn.disabled = true;

                var valid = await _aiValidateKey(newProvider, newKey, newModel);
                saveBtn.textContent = origText;
                saveBtn.disabled = false;

                if (!valid) {
                    alert(t("settings.invalid_key"));
                    return;
                }
            }

            // Privacy warning when enabling AI
            if (aiToggle && !_aiIsEnabled()) {
                if (!confirm(t("settings.ai_privacy_warning"))) return;
            }

            _aiSetProvider(newProvider);
            _aiSetModel(newModel);
            if (newKey !== _aiGetApiKey()) _aiSetApiKey(newKey);
            var endpointEl = document.getElementById("settings-endpoint");
            _aiSetEndpoint(endpointEl ? endpointEl.value.trim() : "");
            var secretEl = document.getElementById("settings-secret-key");
            _aiSetSecretKey(secretEl ? secretEl.value.trim() : "");
            var regionEl = document.getElementById("settings-region");
            _aiSetRegion(regionEl ? regionEl.value.trim() : "");
            if (_pendingContext !== null) {
                _aiSetContext(_pendingContext);
                _aiSetContextName(_pendingContextName);
            }
            _aiSetEnabled(aiToggle);
            _aiClosePanel();
            if (cfg.onSettingsSaved) cfg.onSettingsSaved();
            else if (typeof renderAll === "function") renderAll();
            showStatus(t("settings.saved"));
        };

        // App-specific post-render hook
        if (cfg.onSettingsRendered) cfg.onSettingsRendered();
    };

    // ═══════════════════════════════════════════════════════════════════
    // PANEL UI (shared overlay + slide-in panel)
    // ═══════════════════════════════════════════════════════════════════

    var _overlayEl = null;
    var _panelEl = null;
    var _titleEl = null;
    var _bodyEl = null;
    var _footerEl = null;

    window._aiEnsurePanel = function() {
        if (_panelEl) return { panel: _panelEl, title: _titleEl, body: _bodyEl, footer: _footerEl };
        _overlayEl = document.createElement("div");
        _overlayEl.className = "ai-overlay";
        var _overlayMouseDown = null;
        _overlayEl.addEventListener("mousedown", function(e) { _overlayMouseDown = e.target; });
        _overlayEl.addEventListener("click", function(e) { if (e.target === _overlayEl && _overlayMouseDown === _overlayEl) _aiClosePanel(); });
        document.body.appendChild(_overlayEl);

        _panelEl = document.createElement("div");
        _panelEl.className = "ai-panel";
        _panelEl.innerHTML = '<div class="ai-panel-header"><span class="ai-panel-title" id="ai-panel-title-text"></span><button class="ai-panel-close" id="ai-close-btn">&times;</button></div><div class="ai-panel-body"></div><div class="ai-panel-footer"></div>';
        document.body.appendChild(_panelEl);

        _titleEl = _panelEl.querySelector(".ai-panel-title");
        _bodyEl = _panelEl.querySelector(".ai-panel-body");
        _footerEl = _panelEl.querySelector(".ai-panel-footer");
        _panelEl.querySelector("#ai-close-btn").onclick = _aiClosePanel;

        return { panel: _panelEl, title: _titleEl, body: _bodyEl, footer: _footerEl };
    };

    window._aiOpenPanel = function(title) {
        _aiEnsurePanel();
        if (title) _titleEl.textContent = title;
        _overlayEl.classList.add("open");
        _panelEl.classList.add("open");
    };

    window._aiClosePanel = function() {
        if (_overlayEl) _overlayEl.classList.remove("open");
        if (_panelEl) _panelEl.classList.remove("open");
    };

    window._aiShowLoading = function(title) {
        var p = _aiEnsurePanel();
        p.title.textContent = title;
        p.body.innerHTML = '<div style="text-align:center;padding:40px"><div class="ai-spinner"></div><p style="margin-top:16px;color:var(--text-muted)">' + t("ai.loading") + '</p></div>';
        p.footer.innerHTML = "";
        _aiOpenPanel();
    };

    window._aiShowError = function(title, errMsg) {
        var p = _aiEnsurePanel();
        p.title.textContent = title;
        p.body.innerHTML = '<div class="ai-error">' + esc(errMsg) + '</div>';
        p.footer.innerHTML = '';
        _aiOpenPanel();
    };

    // ═══════════════════════════════════════════════════════════════════
    // I18N — shared settings + AI keys
    // ═══════════════════════════════════════════════════════════════════

    _registerTranslations("fr", {
        "settings.title": "Réglages",
        "settings.language": "Langue",
        "settings.ai_section": "Assistant IA",
        "settings.ai_enable": "Activer l'assistant IA",
        "settings.provider": "Fournisseur IA",
        "settings.model": "Modèle",
        "settings.api_key": "Clé API",
        "settings.show_key": "Afficher / masquer la clé",
        "settings.api_key_note": "La clé est stockée dans votre navigateur (localStorage) et n'est jamais incluse dans les fichiers sauvegardés. Elle est transmise directement à l'API du fournisseur depuis votre navigateur — elle peut être visible dans les DevTools et par les extensions installées.",
        "settings.endpoint": "Endpoint API (optionnel)",
        "settings.endpoint_note": "Laissez vide pour utiliser l'API officielle du fournisseur. Renseignez une URL custom pour utiliser un proxy ou un endpoint compatible (ex: Azure OpenAI, Ollama, LiteLLM).",
        "settings.secret_key": "Secret Access Key (AWS)",
        "settings.region": "Region AWS",
        "settings.provider_custom": "LLM personnalisé",
        "settings.custom_endpoint_note": "URL complète du endpoint compatible OpenAI (POST, JSON, messages[]).",
        "settings.save": "Enregistrer",
        "settings.saved": "Réglages enregistrés",
        "settings.context_file": "Instructions méthodologiques (Markdown)",
        "settings.context_note": "Chargez un fichier .md contenant vos instructions méthodologiques, référentiels internes ou consignes de rédaction. Ces instructions guideront les suggestions de l'IA.",
        "settings.context_clear": "Supprimer",
        "settings.context_loaded": "Instructions chargées : {name}",
        "settings.ai_needs_key": "Veuillez saisir une clé API pour activer l'assistant IA.",
        "settings.validating_key": "Vérification de la clé...",
        "settings.invalid_key": "La clé API est invalide. Vérifiez la clé et le fournisseur sélectionné.",
        "settings.ai_privacy_warning": "En activant l'assistant IA :\n\n1. PARTAGE DE DONNÉES — Les données de votre analyse (contexte, exigences, mesures) seront envoyées au fournisseur IA sélectionné. Assurez-vous que votre politique de confidentialité et vos engagements contractuels autorisent ce partage.\n\n2. EXPOSITION DE LA CLÉ API — La clé API est transmise depuis votre navigateur. Elle est visible dans les outils de développement (DevTools) et peut être capturée par des extensions navigateur. Utilisez de préférence un navigateur sans extensions ou un profil dédié.\n\n3. RÉSEAU — Les échanges sont chiffrés (HTTPS) mais peuvent être journalisés par un proxy d'entreprise.\n\nVoulez-vous continuer ?",
        "ai.loading": "Génération des suggestions...",
        "ai.invalid_key": "Clé API invalide ou expirée. Vérifiez dans les Réglages.",
        "ai.api_error": "Erreur API :",
        "ai.accept": "Accepter",
        "ai.ignore": "Ignorer",
        "ai.accept_all": "Tout accepter",
        "ai.close": "Fermer",
        "ai.no_suggestions": "Aucune suggestion générée.",
        "ai.parse_error": "Erreur lors de l'analyse de la réponse IA."
    });

    _registerTranslations("en", {
        "settings.title": "Settings",
        "settings.language": "Language",
        "settings.ai_section": "AI Assistant",
        "settings.ai_enable": "Enable AI assistant",
        "settings.provider": "AI Provider",
        "settings.model": "Model",
        "settings.api_key": "API Key",
        "settings.show_key": "Show / hide key",
        "settings.api_key_note": "The key is stored in your browser (localStorage) and never included in saved files. It is transmitted directly to the provider's API from your browser — it may be visible in DevTools and to installed browser extensions.",
        "settings.endpoint": "API Endpoint (optional)",
        "settings.endpoint_note": "Leave empty to use the official provider API. Enter a custom URL for a proxy or compatible endpoint (e.g.: Azure OpenAI, Ollama, LiteLLM).",
        "settings.secret_key": "Secret Access Key (AWS)",
        "settings.region": "AWS Region",
        "settings.provider_custom": "Custom LLM",
        "settings.custom_endpoint_note": "Full URL of the OpenAI-compatible endpoint (POST, JSON, messages[]).",
        "settings.save": "Save",
        "settings.saved": "Settings saved",
        "settings.context_file": "Methodology instructions (Markdown)",
        "settings.context_note": "Upload a .md file with your methodology guidelines, internal frameworks, or writing instructions. These will guide the AI suggestions.",
        "settings.context_clear": "Remove",
        "settings.context_loaded": "Instructions loaded: {name}",
        "settings.ai_needs_key": "Please enter an API key to enable the AI assistant.",
        "settings.validating_key": "Validating key...",
        "settings.invalid_key": "The API key is invalid. Check the key and the selected provider.",
        "settings.ai_privacy_warning": "By enabling the AI assistant:\n\n1. DATA SHARING — Your analysis data (context, requirements, controls) will be sent to the selected AI provider. Make sure your privacy policy and contractual obligations allow this.\n\n2. API KEY EXPOSURE — The API key is transmitted directly from your browser. It is visible in browser DevTools and can be captured by browser extensions. Use a browser without extensions or a dedicated profile.\n\n3. NETWORK — Communications are encrypted (HTTPS) but may be logged by corporate proxies.\n\nDo you want to continue?",
        "ai.loading": "Generating suggestions...",
        "ai.invalid_key": "Invalid or expired API key. Check in Settings.",
        "ai.api_error": "API error:",
        "ai.accept": "Accept",
        "ai.ignore": "Ignore",
        "ai.accept_all": "Accept all",
        "ai.close": "Close",
        "ai.no_suggestions": "No suggestions generated.",
        "ai.parse_error": "Error parsing AI response."
    });

    // ═══════════════════════════════════════════════════════════════════
    // CSS — injected once
    // ═══════════════════════════════════════════════════════════════════

    var style = document.createElement("style");
    style.textContent = [
        ".ai-overlay { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.3); z-index:500; }",
        ".ai-overlay.open { display:block; }",
        ".ai-panel { display:none; position:fixed; top:0; right:-720px; width:700px; max-width:90vw; height:100vh; background:white; box-shadow:-4px 0 24px rgba(0,0,0,0.2); z-index:501; transition:right 0.3s; overflow-y:auto; }",
        ".ai-panel.open { display:block; right:0; }",
        ".ai-panel-header { display:flex; align-items:center; justify-content:space-between; padding:14px 16px; background:var(--blue); color:white; position:sticky; top:0; z-index:1; }",
        ".ai-panel-title { font-weight:700; font-size:0.95em; }",
        ".ai-panel-close { background:none; border:none; color:white; font-size:1.4em; cursor:pointer; padding:0 4px; }",
        ".ai-panel-body { padding:16px; }",
        ".ai-panel-footer { padding:0 16px 16px; }",
        ".ai-card { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:12px; }",
        ".ai-card-title { font-weight:600; font-size:0.9em; margin-bottom:6px; color:var(--blue); }",
        ".ai-card-details { font-size:0.82em; color:var(--text); line-height:1.5; margin-bottom:6px; }",
        ".ai-card-meta { font-size:0.75em; color:var(--text-muted); margin-bottom:8px; }",
        ".ai-card-actions { display:flex; gap:6px; }",
        ".ai-btn-accept { padding:4px 12px; border:none; border-radius:4px; background:var(--green); color:white; font-size:0.8em; font-weight:600; cursor:pointer; }",
        ".ai-btn-accept:hover { opacity:0.85; }",
        ".ai-btn-accept:disabled { opacity:0.5; cursor:default; }",
        ".ai-btn-ignore { padding:4px 12px; border:1px solid var(--border); border-radius:4px; background:white; color:var(--text-muted); font-size:0.8em; cursor:pointer; }",
        ".ai-btn-ignore:hover { background:var(--bg); }",
        ".ai-btn-accept-all, .ai-btn-all { padding:6px 16px; border:none; border-radius:4px; background:var(--green); color:white; font-weight:600; font-size:0.85em; cursor:pointer; }",
        ".ai-btn-accept-all:hover, .ai-btn-all:hover { opacity:0.85; }",
        ".ai-btn-close { padding:6px 16px; border:1px solid var(--border); border-radius:4px; background:white; color:var(--text); font-size:0.85em; cursor:pointer; }",
        ".ai-btn-close:hover { background:var(--bg); }",
        ".ai-spinner { width:32px; height:32px; border:3px solid var(--border); border-top-color:var(--light-blue); border-radius:50%; animation:ai-spin 0.8s linear infinite; margin:0 auto; }",
        "@keyframes ai-spin { to { transform:rotate(360deg); } }",
        ".ai-error { padding:16px; color:#dc2626; background:#fef2f2; border-radius:6px; font-size:0.85em; }",
        ".btn-ai { background:linear-gradient(135deg,#6366f1 0%,#7c3aed 100%); color:#fff; border:none; padding:5px 12px; border-radius:5px; cursor:pointer; font-size:0.8em; font-weight:600; margin-left:auto; white-space:nowrap; }",
        ".btn-ai-sm { padding:2px 6px !important; font-size:0.75em !important; margin-left:4px; border-radius:4px; }",
        ".btn-ai:hover { opacity:0.9; }",
        ".ai-btn-suggest { background:#8b5cf6 !important; color:white !important; padding:2px 6px; margin-left:4px; }",
        ".ai-btn-suggest:hover { opacity:0.85; }",
        // Settings
        ".settings-section { margin-bottom:20px; }",
        ".settings-label { font-weight:600; font-size:0.85em; margin-bottom:8px; color:var(--text); }",
        ".settings-lang-btn { padding:6px 16px; border:1px solid var(--border); border-radius:4px; background:white; cursor:pointer; font-size:0.85em; }",
        ".settings-lang-btn.active { background:var(--blue); color:white; border-color:var(--blue); }",
        ".settings-lang-btn:hover:not(.active) { background:var(--bg); }",
        ".settings-input { padding:6px 10px; border:1px solid var(--border); border-radius:4px; font-size:0.85em; font-family:monospace; }",
        ".settings-btn-eye { background:none; border:1px solid var(--border); border-radius:4px; padding:4px 8px; cursor:pointer; font-size:1em; }",
        ".settings-toggle { position:relative; display:inline-block; width:40px; height:22px; }",
        ".settings-toggle input { opacity:0; width:0; height:0; }",
        ".settings-toggle-slider { position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background:#ccc; transition:.3s; border-radius:22px; }",
        ".settings-toggle-slider:before { content:''; position:absolute; height:16px; width:16px; left:3px; bottom:3px; background:white; transition:.3s; border-radius:50%; }",
        ".settings-toggle input:checked + .settings-toggle-slider { background:var(--green); }",
        ".settings-toggle input:checked + .settings-toggle-slider:before { transform:translateX(18px); }"
    ].join("\n");
    document.head.appendChild(style);

})();
