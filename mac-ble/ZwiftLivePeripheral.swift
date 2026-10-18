import CoreBluetooth
import Foundation

private let serviceUUID = CBUUID(string: "8E6F1000-7A95-4A7F-A8D9-4F6E9A1C2100")
private let stateUUID = CBUUID(string: "8E6F1001-7A95-4A7F-A8D9-4F6E9A1C2100")
private let protocolVersion: UInt8 = 1
private let headerSize = 11

final class ZwiftLivePeripheral: NSObject, CBPeripheralManagerDelegate {
    private var manager: CBPeripheralManager!
    private var characteristic: CBMutableCharacteristic?
    private var latest = Data()
    private var sequence: UInt32 = 0
    private var subscribers: [CBCentral] = []
    private var pending: [(Data, CBCentral)] = []

    override init() {
        super.init()
        manager = CBPeripheralManager(delegate: self, queue: .main)
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        guard peripheral.state == .poweredOn else {
            if peripheral.state != .unknown { print("Bluetooth unavailable: \(peripheral.state.rawValue)"); fflush(stdout) }
            return
        }
        let state = CBMutableCharacteristic(
            type: stateUUID,
            properties: [.read, .notify],
            value: nil,
            permissions: [.readable]
        )
        let service = CBMutableService(type: serviceUUID, primary: true)
        service.characteristics = [state]
        characteristic = state
        peripheral.add(service)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error { print("Could not add BLE service: \(error.localizedDescription)"); return }
        peripheral.startAdvertising([
            CBAdvertisementDataLocalNameKey: "CyclingOS Zwift",
            CBAdvertisementDataServiceUUIDsKey: [serviceUUID]
        ])
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error { print("Could not advertise BLE service: \(error.localizedDescription)") }
        else { print("READY") }
        fflush(stdout)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        if !subscribers.contains(where: { $0.identifier == central.identifier }) { subscribers.append(central) }
        print("SUBSCRIBERS \(subscribers.count)"); fflush(stdout)
        if !latest.isEmpty { enqueue(latest, for: central) }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        subscribers.removeAll { $0.identifier == central.identifier }
        pending.removeAll { $0.1.identifier == central.identifier }
        print("SUBSCRIBERS \(subscribers.count)"); fflush(stdout)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        guard request.characteristic.uuid == stateUUID, request.offset <= latest.count else {
            peripheral.respond(to: request, withResult: .invalidOffset)
            return
        }
        request.value = latest.subdata(in: request.offset..<latest.count)
        peripheral.respond(to: request, withResult: .success)
    }

    func publish(_ data: Data) {
        latest = data
        sequence &+= 1
        for central in subscribers { enqueue(data, for: central) }
        flush()
    }

    private func enqueue(_ data: Data, for central: CBCentral) {
        // A 1 Hz state stream should always prefer the newest frame over draining stale chunks.
        pending.removeAll { $0.1.identifier == central.identifier }
        let payloadSize = max(1, central.maximumUpdateValueLength - headerSize)
        let count = max(1, Int(ceil(Double(data.count) / Double(payloadSize))))
        for index in 0..<count {
            let start = index * payloadSize
            let end = min(data.count, start + payloadSize)
            var packet = Data([0x43, 0x5A, protocolVersion]) // "CZ", protocol v1
            packet.appendLittleEndian(sequence)
            packet.appendLittleEndian(UInt16(index))
            packet.appendLittleEndian(UInt16(count))
            packet.append(data.subdata(in: start..<end))
            pending.append((packet, central))
        }
    }

    private func flush() {
        guard let characteristic else { return }
        while let next = pending.first {
            if !manager.updateValue(next.0, for: characteristic, onSubscribedCentrals: [next.1]) { return }
            pending.removeFirst()
        }
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) { flush() }
}

private extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var little = value.littleEndian
        Swift.withUnsafeBytes(of: &little) { append(contentsOf: $0) }
    }
}

let peripheral = ZwiftLivePeripheral()
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8) else { continue }
        DispatchQueue.main.async { peripheral.publish(data) }
    }
    DispatchQueue.main.async { CFRunLoopStop(CFRunLoopGetMain()) }
}
RunLoop.main.run()
