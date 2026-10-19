using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

// Windows counterpart of mac-ble/ZwiftLivePeripheral.swift. Same GATT layout, same chunk header and
// the same stdin/stdout protocol: one JSON frame per stdin line; prints READY and SUBSCRIBERS <n>.

var serviceUuid = Guid.Parse("8E6F1000-7A95-4A7F-A8D9-4F6E9A1C2100");
var stateUuid = Guid.Parse("8E6F1001-7A95-4A7F-A8D9-4F6E9A1C2100");

var adapter = await BluetoothAdapter.GetDefaultAsync();
if (adapter is null) return Fail("Bluetooth unavailable: no Bluetooth adapter found or Bluetooth is off.");
if (!adapter.IsLowEnergySupported) return Fail("Bluetooth unavailable: this adapter does not support Bluetooth Low Energy.");
if (!adapter.IsPeripheralRoleSupported) return Fail("Bluetooth unavailable: this adapter cannot act as a BLE peripheral. A USB Bluetooth 5 dongle usually can.");

var created = await GattServiceProvider.CreateAsync(serviceUuid);
if (created.Error != BluetoothError.Success) return Fail($"Could not add BLE service: {created.Error}");
var provider = created.ServiceProvider;

var characteristicResult = await provider.Service.CreateCharacteristicAsync(stateUuid, new GattLocalCharacteristicParameters
{
    CharacteristicProperties = GattCharacteristicProperties.Read | GattCharacteristicProperties.Notify,
    ReadProtectionLevel = GattProtectionLevel.Plain,
    UserDescription = "CyclingOS Zwift state"
});
if (characteristicResult.Error != BluetoothError.Success) return Fail($"Could not add BLE characteristic: {characteristicResult.Error}");

var peripheral = new ZwiftLivePeripheral(characteristicResult.Characteristic);

// Windows advertises under the PC's Bluetooth name; the service UUID is what the phone scans for.
// Some adapters abort general-discoverable GATT advertising, so fall back to plain connectable advertising.
var discoverable = true;
provider.AdvertisementStatusChanged += (sender, args) =>
{
    if (args.Status == GattServiceProviderAdvertisementStatus.Started)
    {
        Output.Line("READY");
    }
    else if (args.Status == GattServiceProviderAdvertisementStatus.Aborted && discoverable)
    {
        discoverable = false;
        sender.StartAdvertising(new GattServiceProviderAdvertisingParameters { IsConnectable = true, IsDiscoverable = false });
    }
    else if (args.Status == GattServiceProviderAdvertisementStatus.Aborted)
    {
        Output.Line($"Could not advertise BLE service: {args.Error}");
    }
};
provider.StartAdvertising(new GattServiceProviderAdvertisingParameters { IsConnectable = true, IsDiscoverable = true });
_ = Task.Delay(TimeSpan.FromSeconds(10)).ContinueWith(_ =>
{
    if (provider.AdvertisementStatus != GattServiceProviderAdvertisementStatus.Started)
        Output.Line("Windows has not confirmed BLE advertising. If the phone cannot find this PC, turn Bluetooth off and on, then restart.");
});

using var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
while (await stdin.ReadLineAsync() is { } line)
{
    if (line.Length > 0) peripheral.Publish(Encoding.UTF8.GetBytes(line));
}
provider.StopAdvertising();
return 0;

static int Fail(string message)
{
    Output.Line(message);
    return 1;
}

static class Output
{
    private static readonly object Gate = new();

    public static void Line(string text)
    {
        lock (Gate)
        {
            Console.Out.Write(text + "\n");
            Console.Out.Flush();
        }
    }
}

sealed class ZwiftLivePeripheral
{
    private const byte ProtocolVersion = 1;
    private const int HeaderSize = 11;

    private readonly GattLocalCharacteristic characteristic;
    private readonly object gate = new();
    private readonly List<(byte[] Packet, GattSubscribedClient Client)> pending = new();
    private readonly SemaphoreSlim wake = new(0);
    private readonly HashSet<GattSubscribedClient> subscribers = new();
    private byte[] latest = Array.Empty<byte>();
    private uint sequence;

    public ZwiftLivePeripheral(GattLocalCharacteristic characteristic)
    {
        this.characteristic = characteristic;
        characteristic.ReadRequested += OnReadRequested;
        characteristic.SubscribedClientsChanged += OnSubscribedClientsChanged;
        _ = Task.Run(SendLoop);
    }

    public void Publish(byte[] data)
    {
        lock (gate)
        {
            latest = data;
            sequence = unchecked(sequence + 1);
            foreach (var client in subscribers) Enqueue(data, client);
        }
        wake.Release();
    }

    private void OnSubscribedClientsChanged(GattLocalCharacteristic sender, object args)
    {
        var current = sender.SubscribedClients;
        int count;
        lock (gate)
        {
            foreach (var client in current.Where(c => !subscribers.Contains(c)).ToList())
            {
                subscribers.Add(client);
                if (latest.Length > 0) Enqueue(latest, client);
            }
            subscribers.RemoveWhere(c => !current.Contains(c));
            pending.RemoveAll(p => !subscribers.Contains(p.Client));
            count = subscribers.Count;
        }
        Output.Line($"SUBSCRIBERS {count}");
        wake.Release();
    }

    private async void OnReadRequested(GattLocalCharacteristic sender, GattReadRequestedEventArgs args)
    {
        using var deferral = args.GetDeferral();
        var request = await args.GetRequestAsync();
        if (request is null) return; // the central lacked access
        byte[] snapshot;
        lock (gate) snapshot = latest;
        if (request.Offset > snapshot.Length)
        {
            request.RespondWithProtocolError(GattProtocolError.InvalidOffset);
            return;
        }
        request.RespondWithValue(snapshot.AsBuffer((int)request.Offset, snapshot.Length - (int)request.Offset));
    }

    // Caller holds the lock. A 1 Hz state stream should always prefer the newest frame over draining stale chunks.
    private void Enqueue(byte[] data, GattSubscribedClient client)
    {
        pending.RemoveAll(p => p.Client == client);
        var payloadSize = Math.Max(1, client.MaxNotificationSize - HeaderSize);
        var count = Math.Max(1, (data.Length + payloadSize - 1) / payloadSize);
        for (var index = 0; index < count; index++)
        {
            var start = index * payloadSize;
            var end = Math.Min(data.Length, start + payloadSize);
            var packet = new byte[HeaderSize + (end - start)];
            packet[0] = 0x43; // "CZ", protocol v1
            packet[1] = 0x5A;
            packet[2] = ProtocolVersion;
            BitConverter.TryWriteBytes(packet.AsSpan(3, 4), sequence);
            BitConverter.TryWriteBytes(packet.AsSpan(7, 2), (ushort)index);
            BitConverter.TryWriteBytes(packet.AsSpan(9, 2), (ushort)count);
            Array.Copy(data, start, packet, HeaderSize, end - start);
            pending.Add((packet, client));
        }
    }

    // Notifications are sent one at a time so a slow phone back-pressures instead of queueing stale frames.
    private async Task SendLoop()
    {
        for (;;)
        {
            await wake.WaitAsync();
            for (;;)
            {
                (byte[] Packet, GattSubscribedClient Client) next;
                lock (gate)
                {
                    if (pending.Count == 0) break;
                    next = pending[0];
                    pending.RemoveAt(0);
                }
                try
                {
                    await characteristic.NotifyValueAsync(next.Packet.AsBuffer(), next.Client);
                }
                catch (Exception error)
                {
                    Output.Line($"Notify failed: {error.Message}");
                }
            }
        }
    }
}
