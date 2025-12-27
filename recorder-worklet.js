class RecorderProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];
        if (input && input[0] && input[0].length > 0) {
            this.port.postMessage(Array.from(input[0]));
        }
        return true;
    }
}
registerProcessor('recorder-processor', RecorderProcessor);
