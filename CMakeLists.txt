# SPDX-License-Identifier: MIT

cmake_minimum_required(VERSION 3.14)
project(EncosMotorCLI VERSION 1.14.0)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(WIN32)
  add_compile_definitions(NOMINMAX WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS)
endif()

if (NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(FTXUI_ENABLE_INSTALL OFF)
option(EMCLI_BUILD_TESTS "Build emcli tests" OFF)
find_package(encos_driver 4.0.0 REQUIRED)
find_package(Threads REQUIRED)
add_subdirectory(external/ftxui)
add_subdirectory(external/argparse)
add_subdirectory(external/serialib)
add_subdirectory(external/nanobench)

# === emcli ===
add_executable(
  emcli
  main.cc
  cli_command.cc
  components/control_panel.cc
  components/graph_panel.cc
  components/left_panel.cc
  components/middle_panel.cc
  components/settings_panel.cc
  src/cli/adapter_cli_utils.cc
  src/cli/bench.cc
  src/cli/battery.cc
  src/cli/glove.cc
  src/cli/help_text.cc
  src/cli/imu.cc
  src/cli/interface_name.cc
  src/cli/slave_config.cc
  src/cli/firmware_download.cc
  src/cli/firmware_download_platform.cc
  src/cli/pms.cc
  src/cli/play.cc
  src/cli/stress.cc
  src/cli/platform_compat.cc
  src/driver_version.cc
  src/trajectory_csv_parser.cc
  src/trajectory_player.cc
  src/csv_parser.cc
)

target_include_directories(emcli PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

target_compile_definitions(emcli PRIVATE EMCLI_VERSION="${PROJECT_VERSION}")

if(MSVC)
  set(EMCLI_WARNING_FLAGS /W4 /WX /utf-8)
else()
  set(EMCLI_WARNING_FLAGS -Wall -Wextra -Werror -Wpedantic)
endif()
target_compile_options(emcli PRIVATE ${EMCLI_WARNING_FLAGS})
set_property(TARGET emcli PROPERTY CXX_STANDARD 17)

target_link_libraries(
  emcli
  PRIVATE
    Encos::encos_driver
    ftxui::screen
    ftxui::dom
    ftxui::component
    argparse::argparse
    ${CMAKE_DL_LIBS}
    Threads::Threads
    nanobench::nanobench
    serialib
)

if(WIN32)
  target_link_libraries(emcli PRIVATE ws2_32 iphlpapi setupapi cfgmgr32 advapi32)
endif()

if(EMCLI_BUILD_TESTS)
  enable_testing()

  add_executable(
    emcli_tests
    tests/test_main.cc
    tests/cli_command_test.cc
    tests/slave_config_test.cc
    tests/firmware_download_test.cc
    tests/control_panel_test.cc
    tests/bench_parser_test.cc
    tests/play_parser_test.cc
    tests/interface_name_test.cc
    tests/left_panel_test.cc
    cli_command.cc
    components/control_panel.cc
    components/left_panel.cc
    src/cli/adapter_cli_utils.cc
    src/cli/bench.cc
    src/cli/battery.cc
    src/cli/glove.cc
    src/cli/help_text.cc
    src/cli/imu.cc
    src/cli/interface_name.cc
    src/cli/slave_config.cc
    src/cli/firmware_download.cc
    src/cli/firmware_download_platform.cc
    src/cli/pms.cc
    src/cli/play.cc
    src/cli/stress.cc
      tests/adapter_timing_test.cc
    src/cli/platform_compat.cc
    src/driver_version.cc
    src/trajectory_csv_parser.cc
    src/trajectory_player.cc
    src/csv_parser.cc
    )

  target_include_directories(
    emcli_tests
    PRIVATE
      ${CMAKE_CURRENT_SOURCE_DIR}
      ${CMAKE_CURRENT_SOURCE_DIR}/external/argparse/test
  )

  target_compile_options(emcli_tests PRIVATE ${EMCLI_WARNING_FLAGS})
  set_property(TARGET emcli_tests PROPERTY CXX_STANDARD 17)

  target_compile_definitions(
    emcli_tests
    PRIVATE
      EMCLI_BIN="$<TARGET_FILE:emcli>"
  )

  target_link_libraries(
    emcli_tests
    PRIVATE
      Encos::encos_driver
      ftxui::screen
      ftxui::dom
      ftxui::component
      argparse::argparse
      ${CMAKE_DL_LIBS}
      Threads::Threads
      nanobench::nanobench
    serialib
  )

  add_dependencies(emcli_tests emcli)

  if(WIN32)
    target_link_libraries(emcli_tests PRIVATE ws2_32 iphlpapi setupapi cfgmgr32 advapi32)
  endif()

  add_test(NAME emcli_tests COMMAND emcli_tests)
  find_package(Python3 COMPONENTS Interpreter REQUIRED)
  if(NOT WIN32)
    add_test(NAME slave_cdc_integration COMMAND ${Python3_EXECUTABLE}
      ${CMAKE_CURRENT_SOURCE_DIR}/tests/slave_cdc_integration.py $<TARGET_FILE:emcli>)
    add_test(NAME slave_udp_integration COMMAND ${Python3_EXECUTABLE}
      ${CMAKE_CURRENT_SOURCE_DIR}/tests/slave_udp_integration.py $<TARGET_FILE:emcli>)
    set_tests_properties(slave_cdc_integration slave_udp_integration PROPERTIES RUN_SERIAL TRUE TIMEOUT 20)
  endif()

  add_executable(
    emzero_tests
    tests/emzero_test_main.cc
      tests/trajectory_csv_parser_test.cc
    tests/trajectory_player_test.cc
    src/trajectory_csv_parser.cc
    src/trajectory_player.cc
    src/csv_parser.cc
  )

  target_include_directories(
    emzero_tests
    PRIVATE
      ${CMAKE_CURRENT_SOURCE_DIR}
      ${CMAKE_CURRENT_SOURCE_DIR}/src
      ${CMAKE_CURRENT_SOURCE_DIR}/external/argparse/test
  )

  target_compile_options(emzero_tests PRIVATE ${EMCLI_WARNING_FLAGS})
  set_property(TARGET emzero_tests PROPERTY CXX_STANDARD 17)

  add_test(NAME emzero_tests COMMAND emzero_tests)
endif()

if(WIN32 AND TARGET emcli_tests)
  # 直接运行 ctest 时当前终端可能尚未刷新 PATH，显式给测试进程指定驱动与插件目录。
  set_tests_properties(emcli_tests PROPERTIES ENVIRONMENT
    "PATH=$<TARGET_FILE_DIR:Encos::encos_driver>;ENCOS_PLUGIN_PATH=${ENCOS_PLUGIN_INSTALL_DIR}")
endif()

# === Install ===
install(TARGETS emcli RUNTIME DESTINATION bin)

# === CPack ===
set(CPACK_GENERATOR "DEB")
set(CPACK_SOURCE_GENERATOR "")
set(CPACK_BINARY_STGZ "OFF")
set(CPACK_BINARY_TGZ "OFF")
set(CPACK_BINARY_TZ "OFF")
set(CPACK_BINARY_TBZ2 "OFF")
set(CPACK_BINARY_TXZ "OFF")
set(CPACK_BINARY_RPM "OFF")

set(CPACK_PACKAGE_NAME "emcli")
set(CPACK_PACKAGE_VERSION "${PROJECT_VERSION}")
set(CPACK_PACKAGE_VERSION_MAJOR "${PROJECT_VERSION_MAJOR}")
set(CPACK_PACKAGE_VERSION_MINOR "${PROJECT_VERSION_MINOR}")
set(CPACK_PACKAGE_VERSION_PATCH "${PROJECT_VERSION_PATCH}")
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "Encos Motor CLI - A terminal UI debugger for Encos motors")
set(CPACK_PACKAGE_DESCRIPTION "A debugging and monitoring tool for Encos motors with terminal-based user interface")
set(CPACK_PACKAGE_CONTACT "Sales002@encos.cn")
set(CPACK_PACKAGE_VENDOR "Encos")

set(CPACK_DEBIAN_PACKAGE_MAINTAINER "Encos Maintainer")
set(CPACK_DEBIAN_PACKAGE_VERSION "${PROJECT_VERSION}")
set(CPACK_DEBIAN_FILE_NAME "DEB-DEFAULT")
set(CPACK_DEBIAN_PACKAGE_DEPENDS "libencosdriver (>= 4.0.0), libencosdriver (<< 4.1.0)")
set(CPACK_DEBIAN_PACKAGE_SECTION "utils")
set(CPACK_DEBIAN_PACKAGE_PRIORITY "optional")

set(CPACK_RPM_PACKAGE_LICENSE "MIT")
set(CPACK_RPM_PACKAGE_GROUP "Applications/Engineering")
set(CPACK_RPM_PACKAGE_REQUIRES "libencosdriver >= 4.0.0, libencosdriver < 4.1.0")

set(CPACK_RESOURCE_FILE_LICENSE "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE")
set(CPACK_RESOURCE_FILE_README "${CMAKE_CURRENT_SOURCE_DIR}/README.md")
set(CPACK_GENERATOR "DEB")

# DEB/RPM 打包仅支持 Linux；Windows 仅保留 install 规则。
if(NOT WIN32)
  include(CPack)
endif()

add_custom_target(format-check
    COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/scripts/run_clang_format.sh --check
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
    COMMENT "Running clang-format check"
)

add_custom_target(format
    COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/scripts/run_clang_format.sh
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
    COMMENT "Formatting project sources with clang-format"
)

add_custom_target(tidy
    COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/scripts/run_clang_tidy.sh ${CMAKE_BINARY_DIR}
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
    COMMENT "Running clang-tidy on project translation units"
)
