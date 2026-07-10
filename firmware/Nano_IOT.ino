//Last modified - 17/09/2025

#include <ArduinoJson.h>
#include <ModbusMaster.h>

//#define SERIAL_BUFFER_SIZE 4096
//const size_t BUFFER_SIZE = 4096;
#define SERIAL_BUFFER_SIZE 12288
const size_t BUFFER_SIZE = 12288;
char inputBuffer[BUFFER_SIZE];
int Modbus_Baud = 9600;
long Polling = 1700;
int TimeOut = 5000;
#define RS485_CONTROL_PIN 3  // DE/RE pin for RS485 transceiver

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

void setup() {
  Serial.begin(115200);
  while (!Serial);
  Serial.println("Ready to receive JSON...");

  pinMode(RS485_CONTROL_PIN, OUTPUT);
  digitalWrite(RS485_CONTROL_PIN, LOW);

  Serial1.begin(Modbus_Baud);
  node.begin(1, Serial1);
  node.preTransmission(preTransmission);
  node.postTransmission(postTransmission);
}

void loop() {
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
      Serial.println("Received JSON:");
      Serial.println(inputBuffer);
      Serial.flush();
      StaticJsonBuffer<BUFFER_SIZE> jsonBuffer;
      JsonObject& root = jsonBuffer.parseObject(inputBuffer);

      if (!root.success()) {
        Serial.println("Error: JSON parsing failed!");
        Serial.flush();
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
//              transferParams.printTo(Serial);
//              Serial.println();
//              Serial.flush();
              //exit(0);
            }
          }
        } else {
          transferPacketCount = 0;
        }

        JsonArray& commArray = root["comm"];
        Modbus_Baud = (int)commArray[1];
        Polling = (int)commArray[0];
        TimeOut = (int)commArray[2];
        Serial1.begin(Modbus_Baud);
        node.begin(1, Serial1);
        node.setTimeout(TimeOut);
        packetsReady = true;
        Serial.println("Info: Modbus Packets received");
      }
      index = 0;
    } else {
      inputBuffer[index++] = c;
    }
  }
}

void processModbusPackets() {
  StaticJsonBuffer<BUFFER_SIZE> jsonBuffer;

  for (size_t i = 0; i < readPacketCount; i++) {
    delayMicroseconds(Polling);
    node.begin(readPackets[i].slaveID, Serial1);
    while (Serial1.available()) {
      Serial1.read();
    }
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

    readObj.printTo(Serial);
    Serial.println();
    jsonBuffer.clear();
  }

  for (size_t i = 0; i < writePacketCount; i++) {
    delayMicroseconds(Polling);
    node.begin(writePackets[i].slaveID, Serial1);
    while (Serial1.available()) {
      Serial1.read();
    }

    // Load data into the Modbus transmit buffer
    for (size_t j = 0; j < writePackets[i].dataLength; j++) {
      node.setTransmitBuffer(j, writePackets[i].data[j]);
    }
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
    writeObj.printTo(Serial);
    Serial.println();
    jsonBuffer.clear();
  }

  // --- New loop for transfer packets ---
  for (size_t i = 0; i < transferPacketCount; i++) {
    delayMicroseconds(Polling);

    // 1. Read from the source slave
    node.begin(transferPackets[i].sourceSlaveID, Serial1);
    while (Serial1.available()) {
      Serial1.read();
    }
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
      delayMicroseconds(Polling); // Polling delay before starting the next transaction
      node.begin(transferPackets[i].destinationSlaveID, Serial1);
      while (Serial1.available()) {
        Serial1.read();
      }
      // Load the read data into the transmit buffer
      for (int j = 0; j < transferPackets[i].length; j++) {
        node.setTransmitBuffer(j, node.getResponseBuffer(j));
      }
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
    transferObj.printTo(Serial);
    Serial.println();
    jsonBuffer.clear();
  }

  // Add cleanup for transfer packets
//  if (transferPackets != nullptr) {
//    delete[] transferPackets;
//    transferPackets = nullptr;
//    transferPacketCount = 0;
//  }
}
