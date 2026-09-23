// SPDX-License-Identifier: MIT

#include "src/cli/interface_name.h"

#include <doctest.hpp>
#include <string>

namespace motor_cli {
namespace {

TEST_CASE("GetDisplayInterfaceName extracts AdapterName for RelayWs URL") {
  const std::string url = "http://198.18.0.1:9001/start?token=0&AdapterType=EthercatIGH&AdapterName=vethaca0f35";
  CHECK(GetDisplayInterfaceName("RelayWs", url) == "vethaca0f35");
}

TEST_CASE("GetLoggerName extracts AdapterName for RelayWs URL") {
  const std::string url = "http://198.18.0.1:9001/start?token=0&AdapterType=EthercatIGH&AdapterName=vethaca0f35";
  CHECK(GetLoggerName("RelayWs", url) == "vethaca0f35");
}

TEST_CASE("AdapterName is extracted from different positions in query string") {
  const std::string leading = "http://example.com/start?AdapterName=eth0&token=1";
  const std::string trailing = "http://example.com/start?token=1&AdapterName=eth1";
  CHECK(GetDisplayInterfaceName("RelayWs", leading) == "eth0");
  CHECK(GetDisplayInterfaceName("RelayWs", trailing) == "eth1");
}

TEST_CASE("URL-encoded AdapterName is decoded") {
  const std::string url = "http://example.com/start?AdapterName=veth%20name";
  CHECK(GetDisplayInterfaceName("RelayWs", url) == "veth name");
}

TEST_CASE("Missing or empty AdapterName falls back to full URL") {
  const std::string no_param = "http://example.com/start?token=0";
  const std::string empty_param = "http://example.com/start?AdapterName=";
  CHECK(GetDisplayInterfaceName("RelayWs", no_param) == no_param);
  CHECK(GetDisplayInterfaceName("RelayWs", empty_param) == empty_param);
}

TEST_CASE("Non-RelayWs adapter types keep the original interface name") {
  const std::string url = "http://198.18.0.1:9001/start?AdapterName=vethaca0f35";
  CHECK(GetDisplayInterfaceName("Ethercat", url) == url);
  CHECK(GetDisplayInterfaceName("wsRelay", url) == url);
}

TEST_CASE("Non-URL RelayWs interface names are returned unchanged") {
  const std::string name = "vethaca0f35";
  CHECK(GetDisplayInterfaceName("RelayWs", name) == name);
}

TEST_CASE("Non-http schemes keep the original interface name") {
  const std::string ftp = "ftp://example.com/start?AdapterName=eth0";
  CHECK(GetDisplayInterfaceName("RelayWs", ftp) == ftp);
}

}  // namespace
}  // namespace motor_cli
