#include "src/cli/firmware_download.h"
#include <cassert>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
using namespace motor_cli;
void Throws(const std::function<void()>& action) {
    bool failed=false;try{action();}catch(const std::exception&){failed=true;}assert(failed);
}
int main(int argc,char** argv) {
    assert(argc==2);
    const auto bytes=MakeOtaPackage({'a','b','c'},8);
    assert(bytes.size()==9*512);
    const FirmwareBytes magic={0x2d,0x4d,0x50,0x48,0x57,0x51,0x5d,0x9e};
    assert(FirmwareBytes(bytes.begin(),bytes.begin()+8)==magic);
    const FirmwareBytes hash={0xba,0x78,0x16,0xbf,0x8f,0x01,0xcf,0xea,0x41,0x41,0x40,0xde,0x5d,0xae,0x22,0x23,0xb0,0x03,0x61,0xa3,0x96,0x17,0x7a,0x9c,0xb4,0x10,0xff,0x61,0xf2,0x00,0x15,0xad};
    assert(FirmwareBytes(bytes.begin()+56,bytes.begin()+88)==hash);
    assert(bytes[12]==8 && bytes[8*512+284]=='a');
    Throws([]{MakeOtaPackage({},1);});
    Throws([]{MakeOtaPackage({'a'},0);});
    Throws([]{MakeOtaPackage(FirmwareBytes(0xbf001),1);});
    auto before=ParseOtaStatus("OK OTA SLOT=1 VERSION=7 CONFIRMED=1 PENDING=4294967295 READY=1");
    auto after=ParseOtaStatus("OK OTA SLOT=0 VERSION=8 CONFIRMED=0 PENDING=4294967295 READY=1");
    CheckOtaResult(before,after,8);
    Throws([&]{CheckOtaResult(before,before,8);});
    Throws([]{ParseOtaStatus("OK OTA SLOT=1 VERSION=7");});
    const auto path=std::filesystem::path(argv[1])/"invalid.elf";
    {std::ofstream file(path,std::ios::binary);file<<"not an ELF";}
    Throws([&]{LoadOtaFirmware(path);});
    const auto package_path = std::filesystem::path(argv[1]) / "firmware.upd";
    const auto write_package = [&](const FirmwareBytes& data) {
        std::ofstream file(package_path, std::ios::binary);
        file.write(reinterpret_cast<const char*>(data.data()), data.size());
    };

    write_package(bytes);
    const auto loaded = LoadOtaPackage(package_path);
    assert(loaded.version == 8);
    assert(loaded.bytes == bytes);

    for (const auto offset : {size_t(0), size_t(12), size_t(16), size_t(20),
                              size_t(24), size_t(508), size_t(56), size_t(8 * 512 + 284)}) {
        auto corrupt = bytes;
        corrupt[offset] ^= 1;
        write_package(corrupt);
        Throws([&] { LoadOtaPackage(package_path); });
    }

    auto truncated = bytes;
    truncated.pop_back();
    write_package(truncated);
    Throws([&] { LoadOtaPackage(package_path); });

    std::cout<<"Firmware framing, checksum, upgrade confirmation and invalid ELF checks passed\n";
}
