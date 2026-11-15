// Exact method text from SillyTavern 1.19.0 / 7e8663cd9, AGPL-3.0.
// Surrounding test state is synthetic; no host settings or conversation is loaded.
export class PromptManagerFixture {
    constructor() {
        this.configuration = { prefix: 'completion_', listIdentifier: 'completion_prompt_manager_list' };
        this.activeCharacter = { id: 'synthetic' };
        this.entries = [{ identifier: 'main', enabled: true }];
        this.counts = { main: 42 };
        this.tokenHandler = { getCounts: () => this.counts };
        this.renderCalls = 0;
        this.saveCalls = 0;
        this.render = () => { this.renderCalls++; };
        this.saveServiceSettings = () => { this.saveCalls++; };
        this.handleToggle = (event) => {
            const promptID = event.target.closest('.' + this.configuration.prefix + 'prompt_manager_prompt').dataset.pmIdentifier;
            const promptOrderEntry = this.getPromptOrderEntry(this.activeCharacter, promptID);
            const counts = this.tokenHandler.getCounts();

            counts[promptID] = null;
            promptOrderEntry.enabled = !promptOrderEntry.enabled;
            this.render();
            this.saveServiceSettings();
        };
    }
    getPromptOrderForCharacter() { return this.entries; }
    isPromptDisabledForActiveCharacter(identifier) {
        const promptOrderEntry = this.getPromptOrderEntry(this.activeCharacter, identifier);
        if (promptOrderEntry) return !promptOrderEntry.enabled;
        return false;
    }
    getPromptOrderEntry(character, identifier) {
        return this.getPromptOrderForCharacter(character).find(entry => entry.identifier === identifier) ?? null;
    }
}
