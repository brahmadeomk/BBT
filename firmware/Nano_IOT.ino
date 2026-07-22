//Last modified - 22/07/2026
//
// Hang fix (stops transmitting after some hours, repeatably). Root causes
// addressed in this revision, all internal - the Pi<->Nano wire format
// (read/write/transfer/comm in, {"t":..,"st":..} lines out) is UNCHANGED,
// so the Node-RED side needs no change:
//   1. RAM exhaustion on the 32 KB SAMD21: the per-loop response builder
//      used a 12 KB StaticJsonBuffer on the stack every loop() on top of
//      the 12 KB static inputBuffer -> stack/heap collision -> hard fault
//      after hours. The response builder only ever holds ONE small packet
//      result, so it now uses RESPONSE_BUFFER_SIZE (4 KB).
//   2. USB-CDC back-pressure: Serial.print/flush block when the host (Pi)
//      stops reading, wedging the poll loop. Writes are now guarded by
//      `if (Serial)` and the blocking flush() calls are gone.
//   3. No recovery from a wedge: a SAMD watchdog now auto-resets on any
//      hang; Watchdog.reset() is fed at the top of loop() and per Modbus
//      packet so legitimate long poll cycles don't trip it. After a reset
//      the Nano waits for the Pi to resend the job (the Pi's serial-silence
//      watchdog already does this).
//   4. Boot could wedge: `while(!Serial);` blocked forever if the host
//      never reopened the port after a reset - now bounded to 2 s.
//   5. Robustness: `comm` is validated before Serial1.begin (a malformed
//      comm used to set baud 0 and silently kill Modbus); delayMicroseconds
//      is only accurate to ~16383 us, so long polls use delay() for the ms.
//
// Requires the Adafruit SleepyDog library (Watchdog) - install via the
// Library Manager before building.

#include <ArduinoJson.h>
#include <ModbusMaster.h>
#include <Adafruit_SleepyDog.h>

//#define SERIAL_BUFFER_SIZE 4096
//const size_t BUFFER_SIZE = 4096;
#define SERIAL_BUFFER_SIZE 12288
const size_t BUFFER_SIZE = 12288;          // input job buffer (holds a whole job)
const size_t RESPONSE_BUFFER_SIZE = 4096;  // per-packet response builder (one result at a time)
char inputBuffer[BUFFER_SIZE];
int Modbus_Baud = 9600;
long Polling = 1700;
int TimeOut = 5000;
#define RS485_CONTROL_PIN 3  // DE/RE pin for RS485 transceiver
#define WATCHDOG_WINDOW_MS 16000  // must exceed one Modbus transaction (TimeOut, capped below)
#define MODBUS_TIMEOUT_MAX 15000  // keep one transaction safely under the watchdog window

struct ReadPacket {
  int slaveID;
  int startAddr;
  int length;
};

struct WritePacket {
  int slaveID;
  int startAddr;
  uint16_t* data;
  size_t dataLength;
};

// New struct to define a data transfer from one slave to another
struct TransferPacket {
  int sourceSlaveID;
  int sourceStartAddr;
  int length;
  int destinationSlaveID;
  int destinationStartAddr;
};

ReadPacket* readPackets = nullptr;
WritePacket* writePackets = nullptr;
TransferPacket* transferPackets = nullptr;

size_t readPacketCount = 0;
size_t writePacketCount = 0;
size_t transferPacketCount = 0;

bool packetsReady = false;

ModbusMaster node;

void preTransmission() {
  digitalWrite(RS485_CONTROL_PIN, HIGH); //transmit enable
}

void postTransmission() {
  digitalWrite(RS485_CONTROL_PIN, LOW); //receive enable
}

void freeWritePackets() {
  if (writePackets != nullptr) {
    for (size_t i = 0; i < writePacketCount; i++) {
      delete[] writePackets[i].data;
    }
    delete[] writePackets;
    writePackets = nullptr;
  }
}

// USB-CDC writes block if the host (Pi) has stopped reading. Skip output
// when no host is attached so a stalled/absent host can never wedge the
// poll loop. When the Pi reconnects, the next poll cycle resumes output.
template <typename T>
void emitJson(T& obj) {
  if (Serial) {
    obj.printTo(Serial);
    Serial.println();
  }
}

// delayMicroseconds() is only accurate up to ~16383 us; use delay() for the
// millisecond part of any longer polling interval.
void pollingDelay(long us) {
  if (us <= 0) return;
  if (us > 16000) {
    delay(us / 1000);
    delayMicroseconds((unsigned int)(us % 1000));
  } else {
    delayMicroseconds((unsigned int)us);
  }
}

void setup() {
  Serial.begin(115200);
  // Do NOT block boot forever waiting for the USB host: after a reset the
  // Pi may not have reopened the port yet. Wait at most 2 s, then proceed.
  unsigned long startWait = millis();
  while (!Serial && (millis() - startWait) < 2000) { }
  if (Serial) Serial.println("Ready to receive JSON...");

  pinMode(RS485_CONTROL_PIN, OUTPUT);
  digitalWrite(RS485_CONTROL_PIN, LOW);

  Serial1.begin(Modbus_Baud);
  node.begin(1, Serial1);
  node.preTransmission(preTransmission);
  node.postTransmission(postTransmission);

  // Hardware watchdog: any hang self-recovers within the window instead of
  // stranding the panel until a manual power cycle.
  Watchdog.enable(WATCHDOG_WINDOW_MS);
}

void loop() {
  Watchdog.reset();  // healthy loop keeps the watchdog fed
  JobManager();
//  if (packetsReady) {
    processModbusPackets();
    // Reset the flag to prevent re-processing without new data
    packetsReady = false;
//  }
}

void JobManager() {
  static size_t index = 0;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '}' || index >= BUFFER_SIZE - 2) {
      inputBuffer[index] = '}';
      inputBuffer[index + 1] = '\0';
      if (Serial) {
        Serial.println("Received JSON:");
        Serial.println(inputBuffer);
      }
      StaticJsonBuffer<BUFFER_SIZE> jsonBuffer;
      JsonObject& root = jsonBuffer.parseObject(inputBuffer);

      if (!root.success()) {
        if (Serial) Serial.println("Error: JSON parsing failed!");
      } else {
        // Handle read packets
        JsonArray& readArray = root["read"];
        if (readArray.success()) {
          readPacketCount = (int)readArray[0];
          if (readPackets != nullptr) {
            delete[] readPackets;
          }
          readPackets = new ReadPacket[readPacketCount];
          size_t storedRead = 0;
          for (size_t i = 1; i < readArray.size() && storedRead < readPacketCount; i++) {
            JsonArray& slaveParams = readArray[i].as<JsonArray>();
            if (slaveParams.success() && slaveParams.size() == 3) {
              readPackets[storedRead].slaveID = (int)slaveParams[0];
              readPackets[storedRead].startAddr = (int)slaveParams[1];
              readPackets[storedRead].length = (int)slaveParams[2];
              storedRead++;
            }
          }
        } else {
          readPacketCount = 0;
        }

        // Handle write packets
        JsonArray& writeArray = root["write"];
        if (writeArray.success()) {
          writePacketCount = (int)writeArray[0];
          freeWritePackets();
          writePackets = new WritePacket[writePacketCount];
          size_t storedWrite = 0;
          for (size_t i = 1; i < writeArray.size() && storedWrite < writePacketCount; i++) {
            JsonArray& slaveWrite = writeArray[i].as<JsonArray>();
            if (slaveWrite.success() && slaveWrite.size() == 3) {
              writePackets[storedWrite].slaveID = (int)slaveWrite[0];
              writePackets[storedWrite].startAddr = (int)slaveWrite[1];
              JsonArray& dataArray = slaveWrite[2].as<JsonArray>();
              writePackets[storedWrite].dataLength = dataArray.size();
              writePackets[storedWrite].data = new uint16_t[dataArray.size()];
              for (size_t j = 0; j < dataArray.size(); j++) {
                writePackets[storedWrite].data[j] = (uint16_t)dataArray[j];
              }
              storedWrite++;
            }
          }
        } else {
          writePacketCount = 0;
        }

        // Handle transfer packets (new logic)
        JsonArray& transferArray = root["transfer"];
        if (transferArray.success()) {
          transferPacketCount = (int)transferArray[0];
          if (transferPackets != nullptr) {
            delete[] transferPackets;
          }
          transferPackets = new TransferPacket[transferPacketCount];
          size_t storedTransfer = 0;
          for (size_t i = 1; i < transferArray.size() && storedTransfer < transferPacketCount; i++) {
            JsonArray& transferParams = transferArray[i].as<JsonArray>();
            if (transferParams.success() && transferParams.size() == 5) {
              transferPackets[storedTransfer].sourceSlaveID = (int)transferParams[0];
              transferPackets[storedTransfer].sourceStartAddr = (int)transferParams[1];
              transferPackets[storedTransfer].length = (int)transferParams[2];
              transferPackets[storedTransfer].destinationSlaveID = (int)transferParams[3];
              transferPackets[storedTransfer].destinationStartAddr = (int)transferParams[4];
              storedTransfer++;
            }
          }
        } else {
          transferPacketCount = 0;
        }

        // Apply comm settings only when present and sane: a malformed comm
        // used to set baud 0 (Serial1.begin(0)) and silently kill Modbus.
        JsonArray& commArray = root["comm"];
        if (commArray.success() && commArray.size() >= 3) {
          long newPoll = (long)commArray[0];
          long newBaud = (long)commArray[1];
          long newTimeout = (long)commArray[2];
          if (newBaud >= 1200 && newBaud <= 921600 && newTimeout > 0) {
            Polling = newPoll;
            Modbus_Baud = (int)newBaud;
            TimeOut = (int)min(newTimeout, (long)MODBUS_TIMEOUT_MAX);
            Serial1.begin(Modbus_Baud);
            node.begin(1, Serial1);
            node.setTimeout(TimeOut);
          } else if (Serial) {
            Serial.println("Warning: comm out of range, keeping previous settings");
          }
        } else if (Serial) {
          Serial.println("Warning: comm missing/invalid, keeping previous settings");
        }
        packetsReady = true;
        if (Serial) Serial.println("Info: Modbus Packets received");
      }
      index = 0;
    } else {
      inputBuffer[index++] = c;
    }
  }
}

void processModbusPackets() {
  // Small per-packet builder (one result at a time) - NOT the 12 KB job
  // buffer. This is the key RAM fix: it used to push 12 KB of stack every
  // loop() on a 32 KB part, next to the 12 KB static inputBuffer.
  StaticJsonBuffer<RESPONSE_BUFFER_SIZE> jsonBuffer;

  for (size_t i = 0; i < readPacketCount; i++) {
    Watchdog.reset();  // keep the watchdog fed across a long multi-slave poll cycle
    pollingDelay(Polling);
    node.begin(readPackets[i].slaveID, Serial1);
    while (Serial1.available()) {
      Serial1.read();
    }
    Watchdog.reset();
    uint8_t result = node.readHoldingRegisters(readPackets[i].startAddr, readPackets[i].length);

    JsonObject& readObj = jsonBuffer.createObject();
    readObj["t"] = "r";
    readObj["id"] = readPackets[i].slaveID;
    readObj["sa"] = readPackets[i].startAddr;
    readObj["len"] = readPackets[i].length;
    JsonArray& values = readObj.createNestedArray("val");

    if (result == node.ku8MBSuccess) {
      for (int j = 0; j < readPackets[i].length; j++) {
        values.add(node.getResponseBuffer(j));
      }
      readObj["st"] = "ok";
    } else {
      readObj["st"] = "err";
    }

    emitJson(readObj);
    jsonBuffer.clear();
  }

  for (size_t i = 0; i < writePacketCount; i++) {
    Watchdog.reset();
    pollingDelay(Polling);
    node.begin(writePackets[i].slaveID, Serial1);
    while (Serial1.available()) {
      Serial1.read();
    }

    // Load data into the Modbus transmit buffer
    for (size_t j = 0; j < writePackets[i].dataLength; j++) {
      node.setTransmitBuffer(j, writePackets[i].data[j]);
    }
    Watchdog.reset();
    // Write multiple registers in a single transaction
    uint8_t result = node.writeMultipleRegisters(writePackets[i].startAddr, writePackets[i].dataLength);

    JsonObject& writeObj = jsonBuffer.createObject();
    writeObj["t"] = "w";
    writeObj["id"] = writePackets[i].slaveID;
    writeObj["sa"] = writePackets[i].startAddr;
    JsonArray& dataSent = writeObj.createNestedArray("dat");

    for (size_t j = 0; j < writePackets[i].dataLength; j++) {
      dataSent.add(writePackets[i].data[j]);
    }

    writeObj["st"] = (result == node.ku8MBSuccess) ? "ok" : "err";
    emitJson(writeObj);
    jsonBuffer.clear();
  }

  // --- New loop for transfer packets ---
  for (size_t i = 0; i < transferPacketCount; i++) {
    Watchdog.reset();
    pollingDelay(Polling);

    // 1. Read from the source slave
    node.begin(transferPackets[i].sourceSlaveID, Serial1);
    while (Serial1.available()) {
      Serial1.read();
    }
    Watchdog.reset();
    uint8_t readResult = node.readHoldingRegisters(transferPackets[i].sourceStartAddr, transferPackets[i].length);

    JsonObject& transferObj = jsonBuffer.createObject();
    transferObj["t"] = "x"; // 'x' for transfer
    transferObj["sid"] = transferPackets[i].sourceSlaveID;
    transferObj["ssa"] = transferPackets[i].sourceStartAddr;
    transferObj["len"] = transferPackets[i].length;
    transferObj["did"] = transferPackets[i].destinationSlaveID;
    transferObj["dsa"] = transferPackets[i].destinationStartAddr;

    if (readResult == node.ku8MBSuccess) {
      // 2. Write to the destination slave
      pollingDelay(Polling); // Polling delay before starting the next transaction
      node.begin(transferPackets[i].destinationSlaveID, Serial1);
      while (Serial1.available()) {
        Serial1.read();
      }
      // Load the read data into the transmit buffer
      for (int j = 0; j < transferPackets[i].length; j++) {
        node.setTransmitBuffer(j, node.getResponseBuffer(j));
      }
      Watchdog.reset();
      uint8_t writeResult = node.writeMultipleRegisters(transferPackets[i].destinationStartAddr, transferPackets[i].length);

      JsonArray& values = transferObj.createNestedArray("val");
      if (writeResult == node.ku8MBSuccess) {
        for (int j = 0; j < transferPackets[i].length; j++) {
          values.add(node.getResponseBuffer(j));
        }
        transferObj["st"] = "ok";
      } else {
        transferObj["st"] = "err_write";
      }
    } else {
      transferObj["st"] = "err_read";
    }
    emitJson(transferObj);
    jsonBuffer.clear();
  }

  // Add cleanup for transfer packets
//  if (transferPackets != nullptr) {
//    delete[] transferPackets;
//    transferPackets = nullptr;
//    transferPacketCount = 0;
//  }
}
