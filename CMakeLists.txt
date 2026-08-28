cmake_minimum_required(VERSION 3.14)
project(EncosMotorCLI VERSION 1.11.0)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if (NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(FTXUI_ENABLE_INSTALL OFF)
option(EMCLI_BUILD_TESTS "Build emcli tests" OFF)
find_package(encos_driver 3.2.0 REQUIRED)
find_package(Threads REQUIRED)
add_subdirectory(external/ftxui)
add_subdirectory(external/argparse)
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
  src/cli/imu.cc
  src/cli/interface_name.cc
  src/cli/pms.cc
  src/cli/play.cc
  src/cli/stress.cc
  src/cli/zero.cc
  src/driver_version.cc
  src/trajectory_csv_parser.cc
  src/trajectory_player.cc
  src/csv_parser.cc
  src/calibration_runner.cc
)

target_include_directories(emcli PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

target_compile_definitions(emcli PRIVATE EMCLI_VERSION="${PROJECT_VERSION}")

target_compile_options(emcli PRIVATE -Wall -Wextra -Werror -Wpedantic)
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
)

if(EMCLI_BUILD_TESTS)
  enable_testing()

  add_executable(
    emcli_tests
    tests/test_main.cc
    tests/cli_command_test.cc
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
    src/cli/imu.cc
    src/cli/interface_name.cc
    src/cli/pms.cc
    src/cli/play.cc
    src/cli/stress.cc
    src/cli/zero.cc
    src/driver_version.cc
    src/trajectory_csv_parser.cc
    src/trajectory_player.cc
    src/csv_parser.cc
    src/calibration_runner.cc
  )

  target_include_directories(
    emcli_tests
    PRIVATE
      ${CMAKE_CURRENT_SOURCE_DIR}
      ${CMAKE_CURRENT_SOURCE_DIR}/external/argparse/test
  )

  target_compile_options(emcli_tests PRIVATE -Wall -Wextra -Werror -Wpedantic)
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
  )

  add_dependencies(emcli_tests emcli)

  add_test(NAME emcli_tests COMMAND emcli_tests)

  add_executable(
    emzero_tests
    tests/emzero_test_main.cc
    tests/csv_parser_test.cc
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

  target_compile_options(emzero_tests PRIVATE -Wall -Wextra -Werror -Wpedantic)
  set_property(TARGET emzero_tests PROPERTY CXX_STANDARD 17)

  add_test(NAME emzero_tests COMMAND emzero_tests)
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
set(CPACK_DEBIAN_PACKAGE_DEPENDS "libencosdriver (>= 3.2.0)")
set(CPACK_DEBIAN_PACKAGE_SECTION "utils")
set(CPACK_DEBIAN_PACKAGE_PRIORITY "optional")

set(CPACK_RPM_PACKAGE_LICENSE "Proprietary")
set(CPACK_RPM_PACKAGE_GROUP "Applications/Engineering")
set(CPACK_RPM_PACKAGE_REQUIRES "libencosdriver >= 3.2.0")

set(CPACK_RESOURCE_FILE_LICENSE "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE")
set(CPACK_RESOURCE_FILE_README "${CMAKE_CURRENT_SOURCE_DIR}/README.md")
set(CPACK_GENERATOR "DEB")

include(CPack)

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
