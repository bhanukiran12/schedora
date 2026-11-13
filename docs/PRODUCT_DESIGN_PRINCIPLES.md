# Schedora product design principles

Use these principles when changing any customer-facing product screen. They draw on Steve Krug's *Don't Make Me Think* and Don Norman's *The Design of Everyday Things*, translated into practical checks for Schedora. They are guidance, not a requirement to copy either book's examples or wording.

## Make the next action obvious

- Use the words customers already use for their task. Explain internal terms where they cannot be avoided.
- Give each screen one clear primary action. Keep secondary actions visually quieter.
- Put an action beside the thing it changes, and show what will happen before an irreversible step.
- Make navigation labels describe destinations, not implementation details.

## Make controls understandable

- A control should look and behave like its purpose: buttons do something, links go somewhere, and menus open without shifting the page around.
- Keep related settings together. Put advanced choices behind a clear, optional step instead of showing every setting in the first task.
- Use familiar ordering and grouping. Keep the result of a choice close to that choice.
- Prevent invalid actions when possible; otherwise explain the issue beside the field and how to fix it.

## Show cause and effect

- After a save, publish, import, or payment action, show whether it succeeded and what changed.
- Preview changes before they reach respondents, customers, or workspace members.
- Preserve user input after errors and make recovery straightforward.
- Use current state labels that say what is true now, such as Draft, Published, or Changes not saved.

## Keep language concrete

- Replace internal labels such as "medium priority distribution" with a short description of who gets the booking and how assignment works.
- Explain limits at the point where they affect a decision. Do not make a headline rely on billing footnotes.
- Avoid promising automation, scoring, integrations, or AI unless the product performs that work today.
- Prefer short sentences, specific verbs, and examples tied to the user's next step.

## Review every change

Before shipping, ask:

1. Can a first-time customer tell what this screen is for?
2. Can they identify the primary action without reading every label?
3. Does each control make its effect clear before they use it?
4. Does the interface confirm the result and offer a recovery path?
5. Can the same task be completed on a narrow screen and with a keyboard?

## References

- Steve Krug, *Don't Make Me Think, Revisited*.
- Don Norman, *The Design of Everyday Things: Revised and Expanded Edition* ([publisher overview](https://mitpress.mit.edu/9780262525671/the-design-of-everyday-things/)).
