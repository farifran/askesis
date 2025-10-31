/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * Calls the backend API to get an analysis from the AI model and streams the response.
 * @param prompt The main prompt for the AI.
 * @param systemInstruction The system instruction for the AI.
 * @param onStreamUpdate A callback function that receives chunks of the response as they arrive.
 * @returns A promise that resolves when the stream is complete.
 */
export async function analyzeHabitData(
    prompt: string,
    systemInstruction: string,
    onStreamUpdate: (chunk: string) => void
): Promise<void> {
    const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, systemInstruction }),
    });

    if (!response.ok) {
        // Attempt to parse a JSON error from the body, otherwise use status text.
        const errorBody = await response.json().catch(() => ({ error: response.statusText, details: '' }));
        throw new Error(`API error: ${response.status} ${errorBody.error} ${errorBody.details}`);
    }

    if (!response.body) {
        throw new Error('Response body is empty');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        onStreamUpdate(chunk); // Callback for real-time UI updates
    }
}