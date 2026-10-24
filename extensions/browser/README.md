# Meet by Schedora browser extension

A toolbar popup for Chrome, Edge and Firefox (Manifest V3): list your booking links, copy them, and create single-use one-off links.

## Install for development
- Chrome / Edge: open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder.
- Firefox: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `manifest.json`.

Connect it with an API key from **Account → API keys** in Schedora. The key is kept in the extension's local storage on that browser.

## Publishing
Zip the folder contents and submit to the Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons (each needs a developer account). Safari needs conversion with `xcrun safari-web-extension-converter` and an Apple developer account. For a Schedora address other than `schedora.in`, add it to `host_permissions` before publishing.
