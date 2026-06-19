// SystemAudioTap.swift
//
// Captures macOS system audio via ScreenCaptureKit and streams it to stdout as
// raw Float32 PCM — mono, 16 kHz — for the MeetScribe Python sidecar to mix
// with the microphone.
//
// Build:
//   swiftc -O SystemAudioTap.swift -o systemtap \
//     -framework ScreenCaptureKit -framework AVFoundation
//
// Requires macOS 13+. On first run macOS prompts for Screen Recording
// permission (System audio capture rides on the screen-recording entitlement).
//
// Protocol:
//   stdout  → little-endian Float32 samples, mono, 16 kHz, interleaved (mono so
//             "interleaved" is moot). No header — a pure PCM stream.
//   stderr  → human-readable diagnostics + fatal errors.
//   exit(0) → clean shutdown (SIGINT/SIGTERM). exit(1) → stream error.

import AVFoundation
import Darwin
import Foundation
import ScreenCaptureKit

// MARK: - Constants

private let kOutputSampleRate: Double = 16_000
private let kOutputChannels: AVAudioChannelCount = 1

// MARK: - Logging helper

@inline(__always)
private func logErr(_ message: String) {
    FileHandle.standardError.write(Data("[systemtap] \(message)\n".utf8))
}

// MARK: - Capture engine

final class SystemAudioCapture: NSObject, SCStreamDelegate, SCStreamOutput {
    private var stream: SCStream?
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private let outputFormat: AVAudioFormat
    private let stdout = FileHandle.standardOutput

    // Serialise writes to stdout off the SCStream sample-handler queue.
    private let writeQueue = DispatchQueue(label: "meetscribe.systemtap.write")

    override init() {
        guard
            let fmt = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: kOutputSampleRate,
                channels: kOutputChannels,
                interleaved: false
            )
        else {
            logErr("failed to create output AVAudioFormat")
            exit(1)
        }
        self.outputFormat = fmt
        super.init()
    }

    func start() async {
        do {
            // Pick the main display; system audio is captured globally regardless
            // of which display/window filter we attach, but SCStream requires a
            // content filter, so we use the primary display with no exclusions.
            let content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: false
            )
            guard let display = content.displays.first else {
                logErr("no displays available to attach audio capture")
                exit(1)
            }

            let filter = SCContentFilter(display: display, excludingWindows: [])

            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.sampleRate = 48_000
            config.channelCount = 2
            config.excludesCurrentProcessAudio = true
            // Keep the video path as cheap as possible — we only want audio.
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.width = 2
            config.height = 2

            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            try stream.addStreamOutput(
                self,
                type: .audio,
                sampleHandlerQueue: DispatchQueue(label: "meetscribe.systemtap.audio")
            )
            try await stream.startCapture()
            self.stream = stream
            logErr("capture started (48kHz stereo → 16kHz mono Float32)")
        } catch {
            logErr("start failed: \(error.localizedDescription)")
            exit(1)
        }
    }

    func stop() async {
        guard let stream else { return }
        do {
            try await stream.stopCapture()
        } catch {
            logErr("stop error (ignored): \(error.localizedDescription)")
        }
        self.stream = nil
    }

    // MARK: SCStreamOutput

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio, sampleBuffer.isValid else { return }
        guard let pcm = makeInputBuffer(from: sampleBuffer) else { return }
        guard let resampled = resample(pcm) else { return }
        writeMono(resampled)
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        logErr("stream stopped with error: \(error.localizedDescription)")
        exit(1)
    }

    // MARK: - Conversion

    /// Build an AVAudioPCMBuffer from the CMSampleBuffer, lazily creating the
    /// AVAudioConverter the first time we learn the real input format.
    private func makeInputBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard
            let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
            let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)
        else { return nil }

        if inputFormat == nil {
            guard let fmt = AVAudioFormat(streamDescription: asbd) else {
                logErr("could not derive AVAudioFormat from sample buffer")
                return nil
            }
            inputFormat = fmt
            converter = AVAudioConverter(from: fmt, to: outputFormat)
            if converter == nil {
                logErr("AVAudioConverter init failed")
            }
            logErr("input format: \(fmt.sampleRate)Hz \(fmt.channelCount)ch")
        }

        guard let inputFormat else { return nil }
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frames > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: frames)
        else { return nil }
        buffer.frameLength = frames

        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frames),
            into: buffer.mutableAudioBufferList
        )
        guard status == noErr else {
            logErr("CMSampleBufferCopyPCMDataIntoAudioBufferList failed: \(status)")
            return nil
        }
        return buffer
    }

    /// Resample 48kHz stereo → 16kHz mono using AVAudioConverter.
    private func resample(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let converter else { return nil }

        // Output capacity must accommodate the down/upsample ratio.
        let ratio = outputFormat.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount((Double(input.frameLength) * ratio).rounded(.up) + 16)
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            return nil
        }

        var fed = false
        var convError: NSError?
        let status = converter.convert(to: output, error: &convError) { _, outStatus in
            if fed {
                outStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            outStatus.pointee = .haveData
            return input
        }

        if let convError {
            logErr("convert error: \(convError.localizedDescription)")
            return nil
        }
        guard status != .error, output.frameLength > 0 else { return nil }
        return output
    }

    /// Write the mono Float32 channel data straight to stdout.
    private func writeMono(_ buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0] else { return }
        let byteCount = Int(buffer.frameLength) * MemoryLayout<Float>.size
        let data = Data(bytes: channel, count: byteCount)
        writeQueue.async { [stdout] in
            do {
                try stdout.write(contentsOf: data)
            } catch {
                // Downstream closed the pipe — nothing left to capture for.
                logErr("stdout closed, exiting")
                exit(0)
            }
        }
    }
}

// MARK: - Entry point

let capture = SystemAudioCapture()

// Graceful shutdown on SIGINT / SIGTERM.
let signalSource = { (signo: Int32) -> DispatchSourceSignal in
    signal(signo, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: signo, queue: .main)
    src.setEventHandler {
        logErr("signal \(signo) received, stopping")
        Task {
            await capture.stop()
            exit(0)
        }
    }
    src.resume()
    return src
}
let sigint = signalSource(SIGINT)
let sigterm = signalSource(SIGTERM)
_ = (sigint, sigterm) // keep alive

Task {
    await capture.start()
}

// Park the main thread on the run loop so async callbacks keep firing.
RunLoop.main.run()
